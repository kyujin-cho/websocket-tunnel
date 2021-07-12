FROM node:14
WORKDIR /app

COPY dist /app/dist
COPY bin /app/bin
COPY package.json /app
COPY yarn.lock /app

RUN yarn install 
EXPOSE 3000

CMD ["yarn", "start", "server", "-v", "trace"]

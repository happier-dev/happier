FROM node:22.14.0-bookworm-slim
WORKDIR /app
# Fixture dependencies live only in this disposable image, never host node_modules.
RUN npm init --yes && npm install --save-exact --omit=dev \
    @opentelemetry/api@1.9.0 \
    @opentelemetry/api-logs@0.208.0 \
    @opentelemetry/sdk-node@0.208.0 \
    @opentelemetry/sdk-logs@0.208.0 \
    @opentelemetry/sdk-trace-base@2.2.0 \
    @opentelemetry/exporter-logs-otlp-proto@0.208.0 \
    @opentelemetry/exporter-trace-otlp-proto@0.208.0 \
    pg@8.16.3
COPY app.cjs ./app.cjs
EXPOSE 3000
CMD ["node", "--expose-gc", "app.cjs"]

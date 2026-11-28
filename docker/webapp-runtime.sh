#!/bin/sh
set -eu
# The browser already consumes this public configuration before build-time defaults.
# Analytics and Sentry keys are optional and omitted when unset, so the generic image sends nothing by default.
printf 'window.__HAPPIER_WEB_RUNTIME_CONFIG__='
jq -cn \
  --arg serverUrl "${HAPPIER_WEBAPP_SERVER_URL:-}" \
  --arg posthogKey "${HAPPIER_WEBAPP_POSTHOG_KEY:-}" \
  --arg posthogHost "${HAPPIER_WEBAPP_POSTHOG_HOST:-}" \
  --arg sentryDsn "${HAPPIER_WEBAPP_SENTRY_DSN:-}" \
  --arg sentryEnvironment "${HAPPIER_WEBAPP_SENTRY_ENVIRONMENT:-}" \
  '{serverUrl: $serverUrl}
    + ({posthogKey: $posthogKey, posthogHost: $posthogHost, sentryDsn: $sentryDsn, sentryEnvironment: $sentryEnvironment}
      | with_entries(select(.value != "")))'

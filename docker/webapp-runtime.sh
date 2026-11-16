#!/bin/sh
set -eu
# The browser already consumes this public configuration before build-time defaults.
printf 'window.__HAPPIER_WEB_RUNTIME_CONFIG__='
jq -cn --arg serverUrl "${HAPPIER_WEBAPP_SERVER_URL:-}" '{serverUrl: $serverUrl}'

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTerminalUsageInstructions } from './terminal_usage_instructions.mjs';

test('renderTerminalUsageInstructions prints a runnable happier command and key env exports', () => {
  const lines = renderTerminalUsageInstructions({
    internalServerUrl: 'http://127.0.0.1:3014',
    cliHomeDir: '/tmp/happier/stack/cli',
    publicServerUrl: 'http://happier-pr.localhost:8084/?server=http%3A%2F%2Flocalhost%3A3014',
  });

  const text = lines.join('\n');
  assert.match(text, /Terminal usage/);
  assert.match(text, /export HAPPIER_SERVER_URL="http:\/\/127\.0\.0\.1:3014"/);
  assert.match(text, /export HAPPIER_HOME_DIR="\/tmp\/happier\/stack\/cli"/);
  assert.match(text, /export HAPPIER_WEBAPP_URL="http:\/\/happier-pr\.localhost:8084/);
  assert.match(text, /\bhappier auth status --json\b/);
  assert.match(text, /\bThen run:\s*happier\b/);
  assert.match(text, /HAPPIER_SERVER_URL="http:\/\/127\.0\.0\.1:3014".*happier/);
});

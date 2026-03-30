import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTerminalUsageInstructions } from './terminal_usage_instructions.mjs';

test('renderTerminalUsageInstructions prints a runnable happier command and key env exports', () => {
  const lines = renderTerminalUsageInstructions({
    internalServerUrl: 'http://127.0.0.1:3014',
    cliHomeDir: '/tmp/happier/stack/cli',
    publicServerUrl: 'http://happier-pr.localhost:8084/?server=http%3A%2F%2Flocalhost%3A3014',
    activeServerId: 'stack_pr-123__id_default',
    stackName: 'pr-123',
  });

  const text = lines.join('\n');
  assert.match(text, /Terminal usage/);
  assert.match(text, /export HAPPIER_SERVER_URL="http:\/\/127\.0\.0\.1:3014"/);
  assert.match(text, /export HAPPIER_HOME_DIR="\/tmp\/happier\/stack\/cli"/);
  assert.match(text, /export HAPPIER_WEBAPP_URL="http:\/\/happier-pr\.localhost:8084/);
  assert.match(text, /export HAPPIER_ACTIVE_SERVER_ID="stack_pr-123__id_default"/);
  assert.match(text, /export HAPPIER_STACK_STACK="pr-123"/);
  assert.match(text, /\bhstack happier auth status --json\b/);
  assert.match(text, /\bThen run:\s*hstack happier\b/);
  assert.match(text, /HAPPIER_STACK_STACK="pr-123".*hstack happier/);
});

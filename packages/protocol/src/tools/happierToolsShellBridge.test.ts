import { describe, expect, it } from 'vitest';

import { parseHappierToolsShellBridgeCommand } from './happierToolsShellBridge.js';

describe('parseHappierToolsShellBridgeCommand', () => {
  it('parses happier tools list invocations', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        'happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      ),
    ).toEqual({
      kind: 'list',
      rawCommand: 'happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      json: true,
    });
  });

  it('parses node-invoked happier tools list bridge commands', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        `'/Users/leeroy/.nvm/versions/node/v22.14.0/bin/node' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'list' '--session-id' 'sess-1' '--directory' '/tmp/workspace' '--json'`,
      ),
    ).toEqual({
      kind: 'list',
      rawCommand:
        `'/Users/leeroy/.nvm/versions/node/v22.14.0/bin/node' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'list' '--session-id' 'sess-1' '--directory' '/tmp/workspace' '--json'`,
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      json: true,
    });
  });

  it('parses happier tools call invocations with JSON args', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        `happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source happier --tool change_title --args-json '{"title":"Renamed"}' --json`,
      ),
    ).toEqual({
      kind: 'call',
      rawCommand:
        `happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source happier --tool change_title --args-json '{"title":"Renamed"}' --json`,
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      source: 'happier',
      tool: 'change_title',
      argsJson: '{"title":"Renamed"}',
      args: { title: 'Renamed' },
      json: true,
    });
  });

  it('strips simple env and unset preludes before parsing', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; FOO=bar happier tools call --source playwright --tool open_page --args-json \'{"url":"https://example.com"}\'',
      ),
    ).toEqual({
      kind: 'call',
      rawCommand:
        'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; FOO=bar happier tools call --source playwright --tool open_page --args-json \'{"url":"https://example.com"}\'',
      sessionId: null,
      directory: null,
      source: 'playwright',
      tool: 'open_page',
      argsJson: '{"url":"https://example.com"}',
      args: { url: 'https://example.com' },
      json: false,
    });
  });

  it('parses env preludes when quoted values contain spaces', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        'HAPPIER_SPAWN_HOOK=\'/Applications/Test Hook/hook.js\' NODE_OPTIONS=\'--require /Applications/Test Hook/register.js\' happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      ),
    ).toEqual({
      kind: 'list',
      rawCommand:
        'HAPPIER_SPAWN_HOOK=\'/Applications/Test Hook/hook.js\' NODE_OPTIONS=\'--require /Applications/Test Hook/register.js\' happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      json: true,
    });
  });

  it('returns null for unrelated shell commands', () => {
    expect(parseHappierToolsShellBridgeCommand('git status --short')).toBeNull();
  });
});

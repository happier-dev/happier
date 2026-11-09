import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));

for (const [command, expectedStatus] of [
  ['git stash list; git stash', 2],
  ['git status --short -- AGENTS.md', 0],
  ['git stash list', 0],
]) {
  test(`configured Codex hook ${expectedStatus === 2 ? 'blocks' : 'allows'} ${command}`, () => {
    const group = config.hooks.PreToolUse?.find((entry) => new RegExp(entry.matcher).test('Bash'));
    assert.ok(group, 'shell calls must reach the PreToolUse guard');
    const hook = group.hooks[0];
    // Execute only the configured hook. The candidate command is stdin data, never shell code.
    const result = spawnSync(process.platform === 'win32' ? hook.commandWindows : hook.command, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '0' },
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 2) assert.match(result.stderr, /BLOCKED/);
  });
}

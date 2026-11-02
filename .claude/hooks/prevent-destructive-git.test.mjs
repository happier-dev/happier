import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const claude = fileURLToPath(new URL('./prevent-destructive-git.sh', import.meta.url));
const codex = fileURLToPath(new URL('../../.codex/hooks/prevent-destructive-git.mjs', import.meta.url));
const denied = [
  'git update-ref HEAD abc',
  'git update-ref refs/heads/v0.3 abc',
  'git status; cd x && git update-ref HEAD abc',
  'git update-ref HEAD abc old; git update-ref HEAD def',
  'echo $(git update-ref HEAD abc)',
  'echo `git update-ref refs/heads/main abc`',
  'git symbolic-ref HEAD refs/heads/other',
  'git symbolic-ref --quiet HEAD refs/heads/other',
  "printf 'update HEAD abc\\n' | git update-ref --stdin",
  "printf 'update refs/tags/v1 HEAD\\nupdate HEAD abc\\n' | git update-ref --stdin",
  "git update-ref --stdin <<'EOF'\nupdate refs/heads/main abc\nEOF",
  'git -C x update-ref -m "write message" HEAD abc',
  'git update-ref -m "log; message" HEAD abc',
  'git stash list >/dev/null; cd x && git stash',
];
const allowed = [
  'git update-ref HEAD abc old',
  'cd x && git update-ref refs/heads/main abc old',
  'echo $(git update-ref HEAD abc old)',
  'git update-ref -m "write message" HEAD abc old',
  'git update-ref -m "log; message" HEAD abc old',
  'git update-ref refs/tags/v1 abc',
  'git symbolic-ref HEAD',
  'git symbolic-ref --quiet HEAD',
  "printf 'update refs/tags/v1 abc\\n' | git update-ref --stdin",
  "git rev-parse HEAD; printf 'update refs/tags/v1 abc\\n' | git update-ref --stdin",
  "printf 'update refs/tags/v1 HEAD\\n' | git update-ref --stdin",
  'git stash list; git stash show',
];

for (const ingress of ['claude', 'codex']) {
  for (const [blocked, commands] of [[true, denied], [false, allowed]]) {
    test(`${ingress}: ${blocked ? 'refuses unsafe writes' : 'preserves legitimate inspection and CAS writes'}`, () => {
      for (const command of commands) {
        const payload = { tool_name: 'Bash', tool_input: { command } };
        const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [ingress === 'claude' ? claude : codex], {
          input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
        });
        assert.ifError(result.error);
        assert.equal(result.status, blocked ? (ingress === 'claude' ? 1 : 2) : 0, command);
      }
    });
  }
}

test('legacy Claude envelope still enforces the same guard', () => {
  const result = spawnSync('bash', [claude], {
    input: JSON.stringify({ tool: 'Bash', args: { command: 'git update-ref HEAD abc' } }), encoding: 'utf8',
    env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
  });
  assert.equal(result.status, 1);
});

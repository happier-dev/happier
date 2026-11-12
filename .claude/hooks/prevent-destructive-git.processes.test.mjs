import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

for (const ingress of ['claude', 'codex']) {
  test(`${ingress}: one Node process evaluates an entire hook invocation`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'git-guard-processes-'));
    const counter = path.join(directory, 'node-count');
    try {
      // Observe real Node starts, including an entry launched with process.execPath.
      const preload = path.join(directory, 'count-node.cjs');
      writeFileSync(preload, "require('node:fs').appendFileSync(process.env.HAPPIER_GUARD_NODE_COUNT, 'node\\n');\n");
      for (const [command, blocked] of [['git status --porcelain', false], ['git reset --hard', true]]) {
        writeFileSync(counter, '');
        const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [
          path.join(root, ingress === 'claude' ? '.claude/hooks/prevent-destructive-git.sh' : '.codex/hooks/prevent-destructive-git.mjs'),
        ], {
          cwd: root,
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require', JSON.stringify(preload)].filter(Boolean).join(' '),
            HAPPIER_GUARD_NODE_COUNT: counter,
            ALLOW_DESTRUCTIVE_GIT: '',
          },
        });
        assert.ifError(result.error);
        assert.equal(result.status, blocked ? (ingress === 'claude' ? 1 : 2) : 0);
        assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 1,
          `${ingress} must evaluate ${blocked ? 'a refusal' : 'an allowed command'} in one Node process`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const ingress of ['claude', 'codex']) {
  test(`${ingress}: read-only stash clauses do not hide a later newline-separated stash`, () => {
    for (const command of ['git stash list\ngit stash', 'git stash\nlist']) {
      const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [
        path.join(root, ingress === 'claude' ? '.claude/hooks/prevent-destructive-git.sh' : '.codex/hooks/prevent-destructive-git.mjs'),
      ], {
        cwd: root,
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
        env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, ingress === 'claude' ? 1 : 2);
    }
  });
}

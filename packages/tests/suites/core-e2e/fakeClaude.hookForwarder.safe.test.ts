import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('fake Claude CLI fixture', () => {
  it('does not execute unparseable SessionStart hook commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-hook-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const sideEffectPath = join(dir, 'side-effect.txt');

      const settingsPath = join(dir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      // Deliberately NOT in the strict node "<script>" <port> form.
                      command: `node -e "require('fs').writeFileSync('${sideEffectPath.replace(/\\/g, '\\\\')}', 'pwned')"` ,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      const res = spawnSync(process.execPath, [fixturePath, '--print', '--output-format', 'stream-json', '--settings', settingsPath], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
        },
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      // Side effect file should never be created.
      await expect(stat(sideEffectPath)).rejects.toThrow();

      const raw = await readFile(logPath, 'utf8');
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(lines.some((l) => l?.type === 'hook_skipped' && l?.reason === 'unparseable_command')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

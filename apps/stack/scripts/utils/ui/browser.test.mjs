import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function readTextOrEmpty(path) {
  return readFile(path, 'utf-8').catch(() => '');
}

test('openUrlInBrowser respects HAPPIER_NO_BROWSER_OPEN and does not invoke OS opener', async (t) => {
  if (process.platform === 'win32') {
    t.skip('uses shell shims tailored for POSIX openers');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-browser-open-'));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const openLogPath = join(tmp, 'open.log');

  try {
    const shim = '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$OPEN_LOG"\n';
    await writeFile(join(tmp, 'open'), shim, { mode: 0o755 });
    await writeFile(join(tmp, 'xdg-open'), shim, { mode: 0o755 });

    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { openUrlInBrowser } from './browser.mjs'; const res = await openUrlInBrowser('http://localhost:54545'); process.stdout.write(JSON.stringify(res));",
      ],
      {
        cwd: scriptDir,
        env: {
          ...process.env,
          PATH: `${tmp}${pathSep}${process.env.PATH ?? ''}`,
          OPEN_LOG: openLogPath,
          HAPPIER_NO_BROWSER_OPEN: '1',
        },
      },
    );

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const stdoutText = String(child.stdout ?? '').trim();
    const parsed = JSON.parse(stdoutText || '{}');
    assert.equal(parsed.ok, false, `expected openUrlInBrowser to skip open\nstdout:\n${child.stdout}`);
    const logContents = await readTextOrEmpty(openLogPath);
    assert.equal(logContents.trim(), '', `expected no OS opener invocations\nlog:\n${logContents}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

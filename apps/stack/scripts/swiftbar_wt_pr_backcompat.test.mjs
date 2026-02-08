import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr }));
  });
}

test('swiftbar wt-pr falls back to legacy component form when modern invocation fails', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const sourceScript = join(rootDir, 'extras', 'swiftbar', 'wt-pr.sh');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-wt-pr-'));
  try {
    const scriptDir = join(tmp, 'swiftbar');
    const binDir = join(tmp, 'bin');
    const logPath = join(tmp, 'hstack.log');
    await mkdir(scriptDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const scriptPath = join(scriptDir, 'wt-pr.sh');
    await copyFile(sourceScript, scriptPath);
    await chmod(scriptPath, 0o755);

    const hstackWrapper = join(scriptDir, 'hstack.sh');
    await writeFile(
      hstackWrapper,
      [
        '#!/bin/sh',
        'set -eu',
        'printf "%s\\n" "$*" >> "${HSTACK_LOG_PATH:?}"',
        '# Fail modern signature (no component arg), succeed legacy signature with component.',
        'if [ "$1" = "wt" ] && [ "$2" = "pr" ] && [ "${3:-}" != "happier-ui" ]; then',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8'
    );
    await chmod(hstackWrapper, 0o755);

    const osascriptPath = join(binDir, 'osascript');
    await writeFile(
      osascriptPath,
      [
        '#!/bin/sh',
        'set -eu',
        'script="$(cat)"',
        'case "$script" in',
        '  *"PR URL or number:"*) echo "123" ;;',
        '  *"Remote to fetch PR from:"*) echo "upstream" ;;',
        '  *"Choose component:"*) echo "happier-ui" ;;',
        '  *) echo "" ;;',
        'esac',
        '',
      ].join('\n'),
      'utf-8'
    );
    await chmod(osascriptPath, 0o755);

    const res = await run(scriptPath, [], {
      cwd: scriptDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HSTACK_LOG_PATH: logPath,
      },
    });

    assert.equal(res.code, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const calls = await readFile(logPath, 'utf-8');
    assert.match(calls, /^wt pr 123 --remote=upstream --use/m);
    assert.match(calls, /^wt pr happier-ui 123 --remote=upstream --use/m);
    assert.match(res.stderr, /legacy component/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('swiftbar wt-pr treats legacy component prompt cancel as a no-op exit 0', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const sourceScript = join(rootDir, 'extras', 'swiftbar', 'wt-pr.sh');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-wt-pr-cancel-'));
  try {
    const scriptDir = join(tmp, 'swiftbar');
    const binDir = join(tmp, 'bin');
    const logPath = join(tmp, 'hstack.log');
    await mkdir(scriptDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const scriptPath = join(scriptDir, 'wt-pr.sh');
    await copyFile(sourceScript, scriptPath);
    await chmod(scriptPath, 0o755);

    const hstackWrapper = join(scriptDir, 'hstack.sh');
    await writeFile(
      hstackWrapper,
      [
        '#!/bin/sh',
        'set -eu',
        'printf "%s\\n" "$*" >> "${HSTACK_LOG_PATH:?}"',
        'exit 1',
        '',
      ].join('\n'),
      'utf-8'
    );
    await chmod(hstackWrapper, 0o755);

    const osascriptPath = join(binDir, 'osascript');
    await writeFile(
      osascriptPath,
      [
        '#!/bin/sh',
        'set -eu',
        'script="$(cat)"',
        'case "$script" in',
        '  *"PR URL or number:"*) echo "123" ;;',
        '  *"Remote to fetch PR from:"*) echo "upstream" ;;',
        '  *"Choose component:"*) echo "" ;;',
        '  *) echo "" ;;',
        'esac',
        '',
      ].join('\n'),
      'utf-8'
    );
    await chmod(osascriptPath, 0o755);

    const res = await run(scriptPath, [], {
      cwd: scriptDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HSTACK_LOG_PATH: logPath,
      },
    });

    assert.equal(res.code, 0, `expected cancellation exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.doesNotMatch(
      res.stderr,
      /failed to create PR worktree/i,
      `did not expect hard failure message on cancellation\nstderr:\n${res.stderr}`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

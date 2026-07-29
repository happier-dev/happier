import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI smoke dry-run schedules installed Provider verification on the canonical prefix', async () => {
  const out = execFileSync(
    process.execPath,
    [resolve(repoRoot, 'scripts', 'pipeline', 'smoke', 'cli-smoke.mjs'), '--dry-run'],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /(packTarball\.mjs|\bnpm pack\b)/);
  assert.match(out, /\bnpm install\b/);
  assert.match(out, /\bhappier\b.*--help/);
  assert.match(out, /\bhappier\b.*--version/);
  assert.match(out, /\bhappier\b.*providers.*--help/);
  assert.match(out, /verify installed Provider artifact/);
  assert.match(out, /activate installed Agent plugins and materialize registered Provider bindings/);

  const dryRunPrefix = resolve(repoRoot, 'dist', 'smoke', 'DRY_RUN_PREFIX');
  const renderedPrefix = dryRunPrefix.includes(' ') ? JSON.stringify(dryRunPrefix) : dryRunPrefix;
  const lines = out.trim().split(/\r?\n/);
  const installLine = lines.find((line) => line.includes('npm install'));
  assert.ok(
    installLine?.includes(`--prefix ${renderedPrefix} `),
    'dry-run must install to the canonical prefix even when its path contains spaces',
  );
  assert.ok(
    lines.includes(`[dry-run] verify installed Provider artifact under ${dryRunPrefix}`),
    'installed Provider verification must consume that exact canonical prefix',
  );
  assert.ok(
    out.indexOf('happier providers --help') < out.indexOf('verify installed Provider artifact'),
    'Provider verification must run after the installed Provider command smoke',
  );
});

test('pipeline CLI smoke dry-run renders a spaced canonical prefix without changing verifier identity', () => {
  const syntheticRepoRoot = fs.mkdtempSync(resolve(tmpdir(), 'happier cli smoke spaced repo '));
  try {
    fs.mkdirSync(resolve(syntheticRepoRoot, 'apps', 'cli'), { recursive: true });
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'smoke', 'cli-smoke.mjs'),
        '--dry-run',
        '--skip-build',
        'true',
      ],
      {
        cwd: syntheticRepoRoot,
        env: { ...process.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    const dryRunPrefix = resolve(
      fs.realpathSync(syntheticRepoRoot),
      'dist',
      'smoke',
      'DRY_RUN_PREFIX',
    );
    const lines = out.trim().split(/\r?\n/);
    const installLine = lines.find((line) => line.includes('npm install'));
    assert.ok(installLine?.includes(`--prefix ${JSON.stringify(dryRunPrefix)} `));
    assert.ok(
      lines.includes(`[dry-run] verify installed Provider artifact under ${dryRunPrefix}`),
      'the verifier must receive the unmodified spaced prefix',
    );
  } finally {
    fs.rmSync(syntheticRepoRoot, { recursive: true, force: true });
  }
});

test('pipeline CLI smoke script resolves spawned commands through the Windows command helper', () => {
  const src = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'smoke', 'cli-smoke.mjs'), 'utf8');
  assert.match(src, /function run\(opts, cmd, args, extra\)[\s\S]*resolveWindowsCommandInvocation\(\{\s*command: cmd,\s*args,/);
});

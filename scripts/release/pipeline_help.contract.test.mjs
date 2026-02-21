import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAnsiStyle } from '../pipeline/cli/ansi-style.mjs';
import { renderCommandHelp } from '../pipeline/cli/help.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

test('pipeline CLI supports --help', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, '--help'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /Happier Pipeline/i);
  assert.match(out, /Usage:/i);
  assert.match(out, /node scripts\/pipeline\/run\.mjs/i);
});

test('pipeline CLI supports help <command>', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'expo-submit'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bexpo-submit\b/);
  assert.match(out, /\bsubmit\b/i);
  assert.match(out, /--environment/);
});

test('pipeline CLI supports help for npm-release', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'npm-release'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bnpm-release\b/);
  assert.match(out, /--channel/);
  assert.match(out, /--publish-cli/);
});

test('pipeline CLI supports help for checks', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'checks'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bchecks\b/);
  assert.match(out, /--profile/);
});

test('pipeline CLI supports <command> --help', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'expo-submit', '--help'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bexpo-submit\b/);
  assert.match(out, /--path/);
});

test('pipeline help covers every supported subcommand', async () => {
  const runSource = fs.readFileSync(pipelineCli, 'utf8');
  const allowlist = Array.from(runSource.matchAll(/subcommand\s*!==\s*'([^']+)'/g)).map((m) => String(m[1] ?? '').trim()).filter(Boolean);
  const unique = [];
  for (const name of allowlist) {
    if (!unique.includes(name)) unique.push(name);
  }

  const style = createAnsiStyle({ enabled: false });
  for (const cmd of unique) {
    const out = renderCommandHelp({ style, command: cmd, cliRelPath: 'scripts/pipeline/run.mjs' });
    assert.doesNotMatch(out, /^Unknown command:/m, `missing help entry for: ${cmd}`);
    assert.match(out, new RegExp(`\\b${cmd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`));
  }
});

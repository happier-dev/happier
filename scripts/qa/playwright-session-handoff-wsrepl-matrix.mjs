// @ts-check

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoDir = resolve(join(__dirname, '..'));

function requireOutdir() {
  const outdir = String(process.env.HAPPIER_QA_OUTDIR ?? '').trim();
  if (!outdir) {
    // eslint-disable-next-line no-console
    console.error('missing HAPPIER_QA_OUTDIR');
    process.exit(2);
  }
  return outdir;
}

async function writeJson(path, payload) {
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function runPlaywright({ outdir }) {
  const script = join(repoDir, 'packages', 'tests', 'scripts', 'run-playwright-with-heartbeat.mjs');
  const config = join(repoDir, 'packages', 'tests', 'playwright.ui.config.mjs');
  const spec = join(
    repoDir,
    'packages',
    'tests',
    'suites',
    'ui-e2e',
    'session.handoff.fromHeaderAction.feat.sessions.handoff.spec.ts',
  );

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, '--config', config, spec], {
      cwd: repoDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
      process.stderr.write(d);
    });

    child.on('exit', (code, signal) => {
      resolvePromise({ code, signal, output });
    });
  });
}

const outdir = requireOutdir();
await mkdir(outdir, { recursive: true });

const summaryPath = join(outdir, 'summary.json');
const fatalPath = join(outdir, 'fatal.json');

const result = await runPlaywright({ outdir });
const ok = result.code === 0;

if (ok) {
  await writeJson(summaryPath, { ok: true });
  process.exit(0);
}

await writeJson(fatalPath, {
  ok: false,
  reason: 'playwright_failed',
  code: result.code,
  signal: result.signal,
});

process.exit(typeof result.code === 'number' ? result.code : 1);


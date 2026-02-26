import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installProviderCli, planProviderCliInstall } from '../dist/providers/index.js';

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

async function createWindowsNpmShimFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-provider-winshim-'));
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const nodeExecPath = process.execPath.replace(/\\/g, '\\\\');
  const cmdExePath = join(binDir, 'cmd.exe');
  const wherePath = join(binDir, 'where');
  const npmCmdPath = join(binDir, 'npm.cmd');

  const cmdExeScript = `#!${nodeExecPath}
const cp = require('node:child_process');

function splitCommandLine(raw) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    let ch = raw[i];
    if (ch === '^' && i + 1 < raw.length) {
      const next = raw[i + 1];
      i += 1;
      if (next === ' ' || next === '\\t') {
        current += next;
        continue;
      }
      ch = next;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\\t')) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const args = process.argv.slice(2);
const cIndex = args.findIndex((a) => String(a).toLowerCase() === '/c');
const rest = cIndex === -1 ? [] : args.slice(cIndex + 1);
if (rest.length === 0) process.exit(1);

let commandLine = rest.join(' ');
if (rest.length === 1) commandLine = rest[0];
if (commandLine.startsWith('"') && commandLine.endsWith('"')) commandLine = commandLine.slice(1, -1);

const tokens = splitCommandLine(commandLine);
if (tokens.length === 0) process.exit(1);

const command = tokens[0];
const commandArgs = tokens.slice(1);
const child = cp.spawn(command, commandArgs, { stdio: 'inherit', env: process.env });

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', () => process.exit(127));
`;

  const whereScript = `#!${nodeExecPath}
const name = process.argv[2];
if (name === 'npm') process.exit(0);
process.exit(1);
`;

  const npmCmdScript = `#!${nodeExecPath}
const args = process.argv.slice(2);
if (args[0] === 'install') process.exit(0);
process.exit(1);
`;

  await writeFile(cmdExePath, cmdExeScript, 'utf8');
  await chmod(cmdExePath, 0o755);
  await writeFile(wherePath, whereScript, 'utf8');
  await chmod(wherePath, 0o755);
  await writeFile(npmCmdPath, npmCmdScript, 'utf8');
  await chmod(npmCmdPath, 0o755);

  return {
    dir,
    binDir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('planProviderCliInstall returns expected commands for claude/codex/gemini', () => {
  const claude = planProviderCliInstall({ providerId: 'claude', platform: 'darwin' });
  assert.equal(claude.ok, true);
  assert.ok(JSON.stringify(claude.plan).includes('claude.ai/install.sh'));

  const codex = planProviderCliInstall({ providerId: 'codex', platform: 'linux' });
  assert.equal(codex.ok, true);
  assert.ok(JSON.stringify(codex.plan).includes('@openai/codex'));

  const gemini = planProviderCliInstall({ providerId: 'gemini', platform: 'win32' });
  assert.equal(gemini.ok, true);
  assert.ok(JSON.stringify(gemini.plan).includes('@google/gemini-cli'));
});

test('planProviderCliInstall includes requiresAdmin hint for qwen windows recipe', () => {
  const qwen = planProviderCliInstall({ providerId: 'qwen', platform: 'win32' });
  assert.equal(qwen.ok, true);
  assert.equal(Boolean(qwen.plan.requiresAdmin), true);
});

test('installProviderCli runs npm.cmd recipes on Windows', async () => {
  const fixture = await createWindowsNpmShimFixture();
  try {
    await withPlatform('win32', async () => {
      const res = installProviderCli({
        providerId: 'codex',
        platform: 'win32',
        skipIfInstalled: false,
        env: {
          PATH: fixture.binDir,
          PATHEXT: '.CMD;.EXE',
          ComSpec: 'cmd.exe',
        },
      });
      assert.equal(res.ok, true);
    });
  } finally {
    await fixture.cleanup();
  }
});

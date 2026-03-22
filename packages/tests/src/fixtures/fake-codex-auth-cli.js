#!/usr/bin/env node

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function resolveHomeDir() {
  const raw = process.platform === 'win32' ? (process.env.USERPROFILE || process.env.HOME) : process.env.HOME;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : homedir();
}

function resolveAuthPath() {
  return join(resolveHomeDir(), '.codex', 'auth.json');
}

function createFakeJwt(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
  return `${header}.${payload}.signature`;
}

async function hasAuthFile() {
  if (!existsSync(resolveAuthPath())) return false;
  try {
    const parsed = JSON.parse(await readFile(resolveAuthPath(), 'utf8'));
    return Boolean(parsed?.tokens?.id_token || parsed?.tokens?.access_token);
  } catch {
    return false;
  }
}

async function writeAuthFile() {
  const authPath = resolveAuthPath();
  await mkdir(join(resolveHomeDir(), '.codex'), { recursive: true });
  const idToken = createFakeJwt('fake-codex@example.test');
  const payload = {
    tokens: {
      id_token: idToken,
      access_token: idToken,
    },
  };
  await writeFile(authPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    process.stdout.write('codex 0.0.0-fake\n');
    process.exit(0);
  }

  if (argv[0] === 'login' && argv[1] === 'status') {
    process.exit((await hasAuthFile()) ? 0 : 1);
  }

  if (argv[0] === 'login') {
    process.stdout.write('Open this URL to authenticate:\n');
    process.stdout.write('https://example.test/fake-codex-auth\n');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeAuthFile();
    process.stdout.write('Authentication complete\n');
    process.exit(0);
  }

  process.stderr.write(`Unsupported fake codex auth invocation: ${argv.join(' ')}\n`);
  process.exit(1);
}

void main();

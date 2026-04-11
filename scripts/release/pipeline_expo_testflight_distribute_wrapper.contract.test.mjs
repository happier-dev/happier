import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

test('expo-testflight-distribute help documents secret loading flags', () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'expo-testflight-distribute'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /--secrets-source <auto\|env\|keychain>/);
  assert.match(out, /--keychain-service <name>/);
  assert.match(out, /--keychain-account <name>/);
});

test('expo-testflight-distribute accepts pipeline secret source flags in dry-run mode', () => {
  assert.doesNotThrow(() => {
    execFileSync(
      process.execPath,
      [
        pipelineCli,
        'expo-testflight-distribute',
        '--environment',
        'dev',
        '--external-groups',
        'beta-a,beta-b',
        '--build-number',
        '123',
        '--app-version',
        '1.2.3',
        '--secrets-source',
        'env',
        '--keychain-service',
        'happier/pipeline',
        '--keychain-account',
        'pipeline',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  });
});

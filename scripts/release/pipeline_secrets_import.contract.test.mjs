import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function createFakeSecurity({ dir, storePath, opsPath }) {
  const securityPath = path.join(dir, 'security');
  writeExecutable(
    securityPath,
    `#!/usr/bin/env bash
set -euo pipefail

cmd="\${1:-}"
shift || true

store="\${SECURITY_STORE_PATH:-${storePath}}"
ops="\${SECURITY_OPS_PATH:-${opsPath}}"

echo "\${cmd} \${*}" >> "\${ops}"

read_store() {
  if [ -f "\${store}" ]; then
    cat "\${store}"
  else
    echo "{}"
  fi
}

key_for() {
  local svc="\${1}"
  local acct="\${2}"
  if [ -z "\${acct}" ]; then
    echo "\${svc}::"
  else
    echo "\${svc}::\${acct}"
  fi
}

if [ "\${cmd}" = "find-generic-password" ]; then
  svc=""
  acct=""
  while [ "\${#}" -gt 0 ]; do
    if [ "\${1}" = "-s" ]; then svc="\${2:-}"; shift 2; continue; fi
    if [ "\${1}" = "-a" ]; then acct="\${2:-}"; shift 2; continue; fi
    shift 1
  done
  key="$(key_for "\${svc}" "\${acct}")"
  json="$(read_store)"
  pw="$(STORE="\${store}" KEY="\${key}" node -e 'const fs=require(\"fs\");const p=process.env.STORE;const k=process.env.KEY;const o=JSON.parse(fs.readFileSync(p,\"utf8\"));process.stdout.write(String(o[k]||\"\"));')"
  if [ -z "\${pw}" ]; then
    echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
    exit 44
  fi
  printf "%s" "\${pw}"
  exit 0
fi

if [ "\${cmd}" = "add-generic-password" ]; then
  svc=""
  acct=""
  pw=""
  while [ "\${#}" -gt 0 ]; do
    if [ "\${1}" = "-s" ]; then svc="\${2:-}"; shift 2; continue; fi
    if [ "\${1}" = "-a" ]; then acct="\${2:-}"; shift 2; continue; fi
    if [ "\${1}" = "-w" ]; then
      pw="\${2:-}"
      shift 2
      continue
    fi
    shift 1
  done
  key="$(key_for "\${svc}" "\${acct}")"
  STORE="\${store}" KEY="\${key}" PW="\${pw}" node -e 'const fs=require(\"fs\");const store=process.env.STORE;const key=process.env.KEY;const pw=process.env.PW;let obj={};try{obj=JSON.parse(fs.readFileSync(store,\"utf8\"))}catch{};obj[key]=pw;fs.writeFileSync(store,JSON.stringify(obj),\"utf8\");'
  exit 0
fi

echo "unsupported security subcommand: \${cmd}" >&2
exit 2
`,
  );
  return securityPath;
}

test('secrets-import merges dotenv values into Keychain bundle without printing values', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const pipelineCli = path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-secrets-import-'));
  const storePath = path.join(tmpDir, 'keychain-store.txt');
  const opsPath = path.join(tmpDir, 'ops.txt');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  createFakeSecurity({ dir: binDir, storePath, opsPath });

  const service = 'happier/pipeline-test';
  const baseAccount = 'tester/base';
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [`${service}::${baseAccount}`]: JSON.stringify({ EXISTING: 'old', UNCHANGED: 'same' }),
    }),
    'utf8',
  );

  const envFile = path.join(tmpDir, '.env.pipeline.local');
  const secret1 = 'SENSITIVE_VALUE_SHOULD_NOT_APPEAR_1';
  const secret2 = 'SENSITIVE_VALUE_SHOULD_NOT_APPEAR_2';
  fs.writeFileSync(
    envFile,
    `# comment
EXISTING="${secret1}"
NEWKEY=${secret2}
EMPTY=
`,
    'utf8',
  );

  const out = execFileSync(
    process.execPath,
    [
      pipelineCli,
      'secrets-import',
      '--env-files',
      envFile,
      '--keychain-service',
      service,
      '--keychain-account',
      'tester',
      '--ignore-missing',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        SECURITY_STORE_PATH: storePath,
        SECURITY_OPS_PATH: opsPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.doesNotMatch(out, new RegExp(secret1));
  assert.doesNotMatch(out, new RegExp(secret2));

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const stored = JSON.parse(store[`${service}::${baseAccount}`]);
  assert.equal(stored.EXISTING, secret1);
  assert.equal(stored.NEWKEY, secret2);
  assert.equal(stored.UNCHANGED, 'same');
  assert.ok(!('EMPTY' in stored));
});

test('secrets-import supports only-missing (does not overwrite existing keys)', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const pipelineCli = path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-secrets-import-only-missing-'));
  const storePath = path.join(tmpDir, 'keychain-store.txt');
  const opsPath = path.join(tmpDir, 'ops.txt');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  createFakeSecurity({ dir: binDir, storePath, opsPath });

  const service = 'happier/pipeline-test';
  const baseAccount = 'tester/base';
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [`${service}::${baseAccount}`]: JSON.stringify({ KEEP: 'keep' }),
    }),
    'utf8',
  );

  const envFile = path.join(tmpDir, '.env.pipeline.local');
  fs.writeFileSync(envFile, `KEEP="overwritten"\nADD="added"\n`, 'utf8');

  execFileSync(
    process.execPath,
    [
      pipelineCli,
      'secrets-import',
      '--env-files',
      envFile,
      '--keychain-service',
      service,
      '--keychain-account',
      'tester',
      '--only-missing',
      'true',
      '--ignore-missing',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        SECURITY_STORE_PATH: storePath,
        SECURITY_OPS_PATH: opsPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const stored = JSON.parse(store[`${service}::${baseAccount}`]);
  assert.equal(stored.KEEP, 'keep');
  assert.equal(stored.ADD, 'added');
});

test('secrets-import dry-run does not write to Keychain bundle', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const pipelineCli = path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-secrets-import-dry-run-'));
  const storePath = path.join(tmpDir, 'keychain-store.txt');
  const opsPath = path.join(tmpDir, 'ops.txt');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  createFakeSecurity({ dir: binDir, storePath, opsPath });

  const service = 'happier/pipeline-test';
  const baseAccount = 'tester/base';
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [`${service}::${baseAccount}`]: JSON.stringify({ BEFORE: 'before' }),
    }),
    'utf8',
  );

  const envFile = path.join(tmpDir, '.env.pipeline.local');
  fs.writeFileSync(envFile, `NEW="new"\n`, 'utf8');

  execFileSync(
    process.execPath,
    [
      pipelineCli,
      'secrets-import',
      '--env-files',
      envFile,
      '--keychain-service',
      service,
      '--keychain-account',
      'tester',
      '--ignore-missing',
      'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        SECURITY_STORE_PATH: storePath,
        SECURITY_OPS_PATH: opsPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const stored = JSON.parse(store[`${service}::${baseAccount}`]);
  assert.deepEqual(stored, { BEFORE: 'before' });

  const ops = fs.readFileSync(opsPath, 'utf8');
  assert.match(ops, /^find-generic-password\b/m);
  assert.doesNotMatch(ops, /^add-generic-password\b/m);
});

test('secrets-import can import base+env files into separate Keychain bundle accounts', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const pipelineCli = path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-secrets-import-env-'));
  const storePath = path.join(tmpDir, 'keychain-store.json');
  const opsPath = path.join(tmpDir, 'ops.txt');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  createFakeSecurity({ dir: binDir, storePath, opsPath });

  const service = 'happier/pipeline-test';
  fs.writeFileSync(storePath, JSON.stringify({}), 'utf8');

  const baseEnvFile = path.join(tmpDir, '.env.pipeline.local');
  const prodEnvFile = path.join(tmpDir, '.env.pipeline.production.local');
  fs.writeFileSync(baseEnvFile, `BASE_ONLY=base\nCOMMON=base_common\n`, 'utf8');
  fs.writeFileSync(prodEnvFile, `PROD_ONLY=prod\nCOMMON=prod_common\n`, 'utf8');

  execFileSync(
    process.execPath,
    [
      pipelineCli,
      'secrets-import',
      '--env',
      'production',
      '--env-files',
      `${baseEnvFile},${prodEnvFile}`,
      '--keychain-service',
      service,
      '--keychain-account',
      'tester',
      '--ignore-missing',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        SECURITY_STORE_PATH: storePath,
        SECURITY_OPS_PATH: opsPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const baseBundle = JSON.parse(store[`${service}::tester/base`]);
  const prodBundle = JSON.parse(store[`${service}::tester/production`]);

  assert.deepEqual(baseBundle, { BASE_ONLY: 'base', COMMON: 'base_common' });
  assert.deepEqual(prodBundle, { PROD_ONLY: 'prod', COMMON: 'prod_common' });
});

test('secrets-import can optionally remove imported env files when --cleanup-env-files=true', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const pipelineCli = path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-secrets-import-cleanup-'));
  const storePath = path.join(tmpDir, 'keychain-store.json');
  const opsPath = path.join(tmpDir, 'ops.txt');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  createFakeSecurity({ dir: binDir, storePath, opsPath });

  const service = 'happier/pipeline-test';
  fs.writeFileSync(storePath, JSON.stringify({}), 'utf8');

  const envFile = path.join(tmpDir, '.env.pipeline.local');
  fs.writeFileSync(envFile, `ONE=1\n`, 'utf8');
  assert.equal(fs.existsSync(envFile), true);

  execFileSync(
    process.execPath,
    [
      pipelineCli,
      'secrets-import',
      '--env-files',
      envFile,
      '--keychain-service',
      service,
      '--keychain-account',
      'tester',
      '--cleanup-env-files',
      'true',
      '--ignore-missing',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        SECURITY_STORE_PATH: storePath,
        SECURITY_OPS_PATH: opsPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.equal(fs.existsSync(envFile), false);
});

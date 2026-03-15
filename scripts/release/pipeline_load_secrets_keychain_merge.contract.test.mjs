import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSecrets } from '../pipeline/secrets/load-secrets.mjs';

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

write_store() {
  local json="\${1}"
  printf "%s" "\${json}" > "\${store}"
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
    if [ "\${1}" = "-w" ]; then pw="\${2:-}"; shift 2; continue; fi
    shift 1
  done
  key="$(key_for "\${svc}" "\${acct}")"
  node - <<'NODE'
const fs = require('fs');
const store = process.env.STORE;
const key = process.env.KEY;
const pw = process.env.PW;
let obj = {};
try { obj = JSON.parse(fs.readFileSync(store,'utf8')); } catch {}
obj[key] = pw;
fs.writeFileSync(store, JSON.stringify(obj), 'utf8');
NODE
  STORE="\${store}" KEY="\${key}" PW="\${pw}"
  exit 0
fi

echo "unsupported security subcommand: \${cmd}" >&2
exit 2
`,
  );
  return securityPath;
}

test('loadSecrets merges base+env Keychain bundles and lets env override Keychain', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-load-secrets-'));
  const storePath = path.join(tmpDir, 'keychain.json');
  const opsPath = path.join(tmpDir, 'ops.txt');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  createFakeSecurity({ dir: binDir, storePath, opsPath });

  const service = 'happier/pipeline-test';
  const store = {
    [`${service}::base`]: JSON.stringify({ A: 'baseA', B: 'baseB' }),
    [`${service}::production`]: JSON.stringify({ B: 'prodB', C: 'prodC' }),
  };
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');

  const prevPath = process.env.PATH || '';
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const { env, usedKeychain } = loadSecrets({
      baseEnv: { B: 'envB', D: 'envD' },
      secretsSource: 'keychain',
      keychainService: service,
      keychainAccount: '',
      deployEnvironment: 'production',
    });

    assert.equal(usedKeychain, true);
    assert.deepEqual(env, { A: 'baseA', B: 'envB', C: 'prodC', D: 'envD' });
  } finally {
    process.env.PATH = prevPath;
  }
});

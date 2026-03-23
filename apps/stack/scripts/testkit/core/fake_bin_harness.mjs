import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { prependPathEntries } from './env_scope.mjs';

const STACK_TEST_PATH_FALLBACKS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

export function writeFakeBin({ root, name, content, binDirName = 'bin' }) {
  const binDir = join(root, binDirName);
  const binPath = join(binDir, name);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(binPath, content, 'utf-8');
  chmodSync(binPath, 0o755);
  return { binDir, binPath };
}

export function writeLoggedJsonBin({
  root,
  name,
  logEnvVar,
  body = '',
  binDirName = 'bin',
} = {}) {
  return writeFakeBin({
    root,
    name,
    binDirName,
    content: `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const log = process.env.${logEnvVar} || '';
if (log) appendFileSync(log, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n", 'utf-8');
${String(body).trim()}
`,
  });
}

export function buildStackHarnessEnv({
  baseEnv = process.env,
  binDirs = [],
  extraEnv = {},
} = {}) {
  const nodeBinDir = dirname(process.execPath);
  return prependPathEntries({
    ...(baseEnv ?? {}),
    ...extraEnv,
  }, [...binDirs, nodeBinDir, ...STACK_TEST_PATH_FALLBACKS]);
}

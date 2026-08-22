#!/usr/bin/env node

import readline from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\n');
  process.exit(0);
}

if (process.argv[2] === 'features' && process.argv[3] === 'list') {
  process.stdout.write('');
  process.exit(0);
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object' || message.id === undefined) return;

  if (message.method === 'initialize') {
    write({ id: message.id, result: { userAgent: 'fake/0.0.0' } });
    return;
  }
  if (message.method === 'model/list') {
    const captureFile = process.env.HAPPIER_HOME_DIR
      ? join(process.env.HAPPIER_HOME_DIR, 'captured-env.json')
      : null;
    if (captureFile) {
      writeFileSync(captureFile, JSON.stringify({
        CODEX_HOME: process.env.CODEX_HOME ?? null,
        CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME ?? null,
        CODEX_AUTH_FILE_PRESENT: typeof process.env.CODEX_HOME === 'string'
          ? existsSync(join(process.env.CODEX_HOME, 'auth.json'))
          : false,
      }));
    }
    write({
      id: message.id,
      result: {
        data: [{
          id: 'gpt-5.4',
          displayName: 'gpt-5.4',
          description: 'Fake model',
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        }],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === 'collaborationMode/list') {
    write({ id: message.id, result: { data: [] } });
    return;
  }
  write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});

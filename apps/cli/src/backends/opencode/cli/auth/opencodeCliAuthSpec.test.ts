import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { opencodeCliAuthSpec } from './opencodeCliAuthSpec';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExecutableShim(params: Readonly<{ dir: string; name: string; body: string }>): string {
  const filePath = join(params.dir, params.name);
  writeFileSync(filePath, `#!/bin/sh\n${params.body}\n`, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

describe('opencodeCliAuthSpec', () => {
  let workDir = '';

  beforeEach(() => {
    workDir = makeTempDir('happier-opencode-auth-');
  });

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('treats a moderately slow auth list probe as logged in when the command succeeds', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const resolvedPath = writeExecutableShim({
      dir: binDir,
      name: 'opencode',
      body: [
        'if [ "$1" = "auth" ] && [ "$2" = "list" ]; then',
        '  sleep 2',
        '  echo "OpenAI alice@example.com oauth"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
    });

    const detectAuthStatus = opencodeCliAuthSpec.detectAuthStatus;

    expect(detectAuthStatus).toBeTypeOf('function');

    if (!detectAuthStatus) {
      throw new Error('Expected opencode CLI auth spec to expose detectAuthStatus');
    }

    const result = await detectAuthStatus({ resolvedPath });

    expect(result).toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'alice@example.com',
    });
  }, 10_000);
});

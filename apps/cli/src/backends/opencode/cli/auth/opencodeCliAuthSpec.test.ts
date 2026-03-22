import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { opencodeCliAuthSpec } from './opencodeCliAuthSpec';

describe('opencodeCliAuthSpec', () => {
  let workDir = '';

  beforeEach(() => {
    workDir = createTempDirSync('happier-opencode-auth-');
  });

  afterEach(() => {
    if (workDir) removeTempDirSync(workDir);
  });

  it.skipIf(process.platform === 'win32')('treats a moderately slow auth list probe as logged in when the command succeeds', async () => {
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const resolvedPath = writeExecutableShimSync({
      dir: binDir,
      fileName: 'opencode',
      contents: [
        '#!/bin/sh',
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

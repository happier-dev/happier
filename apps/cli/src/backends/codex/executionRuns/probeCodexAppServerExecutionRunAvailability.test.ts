import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { probeCodexAppServerExecutionRunAvailability } from './probeCodexAppServerExecutionRunAvailability';

describe('probeCodexAppServerExecutionRunAvailability', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      try {
        chmodSync(path, 0o755);
      } catch {
        // ignore cleanup
      }
    }
  });

  it('rejects a directory override path', () => {
    const dir = join(tmpdir(), `happier-codex-appserver-probe-dir-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    expect(probeCodexAppServerExecutionRunAvailability({ env: { HAPPIER_CODEX_APP_SERVER_BIN: dir } as NodeJS.ProcessEnv })).toBe(false);
  });

  it('rejects a non-executable file override path', () => {
    const file = join(tmpdir(), `happier-codex-appserver-probe-file-${Date.now()}`);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(file, 0o644);
    tempPaths.push(file);
    expect(probeCodexAppServerExecutionRunAvailability({ env: { HAPPIER_CODEX_APP_SERVER_BIN: file } as NodeJS.ProcessEnv })).toBe(false);
  });
});

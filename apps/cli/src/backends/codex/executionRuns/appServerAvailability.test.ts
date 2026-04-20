import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { appServerAvailability } from './appServerAvailability';

describe('appServerAvailability', () => {
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
    expect(appServerAvailability({ env: { HAPPIER_CODEX_APP_SERVER_BIN: dir } as NodeJS.ProcessEnv })).toBe(false);
  });

  it('rejects a non-executable file override path', () => {
    const file = join(tmpdir(), `happier-codex-appserver-probe-file-${Date.now()}`);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(file, 0o644);
    tempPaths.push(file);
    expect(appServerAvailability({ env: { HAPPIER_CODEX_APP_SERVER_BIN: file } as NodeJS.ProcessEnv })).toBe(false);
  });

  it('rejects a codex CLI that exists but does not support the app-server subcommand', () => {
    const dir = join(tmpdir(), `happier-codex-appserver-probe-bin-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const codex = join(dir, 'codex');
    writeFileSync(
      codex,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "codex 0.77.0"',
        '  exit 0',
        'fi',
        'if [ "$1" = "app-server" ]; then',
        '  echo "unknown command: app-server" >&2',
        '  exit 2',
        'fi',
        'exit 0',
      ].join('\n'),
      'utf8',
    );
    chmodSync(codex, 0o755);
    tempPaths.push(codex);

    expect(appServerAvailability({
      env: { PATH: dir } as NodeJS.ProcessEnv,
    })).toBe(false);
  });

  it('probes the command string from provider CLI resolution results', () => {
    const dir = join(tmpdir(), `happier-codex-appserver-probe-resolution-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const codex = join(dir, 'codex');
    writeFileSync(
      codex,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "codex 0.121.0"',
        '  exit 0',
        'fi',
        'if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then',
        '  echo "app-server help"',
        '  exit 0',
        'fi',
        'exit 2',
      ].join('\n'),
      'utf8',
    );
    chmodSync(codex, 0o755);
    tempPaths.push(codex);

    expect(appServerAvailability({
      env: { PATH: dir, HAPPIER_CODEX_PATH: codex } as NodeJS.ProcessEnv,
    })).toBe(true);
  });
});

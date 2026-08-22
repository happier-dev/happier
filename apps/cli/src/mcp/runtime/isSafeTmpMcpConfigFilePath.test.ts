import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { removeConsumedMcpRuntimeConfigFile } from './isSafeTmpMcpConfigFilePath';
import { writeSecureMcpRuntimeConfigFile } from './writeSecureMcpRuntimeConfigFile';
import { createProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';

describe('removeConsumedMcpRuntimeConfigFile', () => {
  it('retires a writer-owned default directory after consuming its only config', async () => {
    const prefix = `happier-mcp-consumed-owned-${process.pid}-${Date.now()}`;
    const configPath = await writeSecureMcpRuntimeConfigFile({ prefix, tmpDir: null, payload: { ok: true } });
    const ownedDirectory = dirname(configPath);

    try {
      await removeConsumedMcpRuntimeConfigFile(configPath, prefix);
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(ownedDirectory)).toBe(false);
    } finally {
      await rm(ownedDirectory, { recursive: true, force: true });
    }
  });

  it('preserves an explicit caller-provided directory after consuming its config', async () => {
    const prefix = `happier-mcp-consumed-explicit-${process.pid}-${Date.now()}`;
    const explicitDirectory = await createProtectedLocalStateDirectory(join(tmpdir(), `${prefix}-`));
    try {
      const configPath = await writeSecureMcpRuntimeConfigFile({
        prefix,
        tmpDir: explicitDirectory,
        payload: { ok: true },
      });

      await removeConsumedMcpRuntimeConfigFile(configPath, prefix);
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(explicitDirectory)).toBe(true);
    } finally {
      await rm(explicitDirectory, { recursive: true, force: true });
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const SRC_ROOT = join(__dirname, '..', '..', '..', '..');
const SDK_VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]@agentclientprotocol\/sdk(?:\/[^'"]*)?['"]/m;

function listProductionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listProductionSources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|testkit)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe('ACP SDK loading', () => {
  it('keeps the SDK out of the static import graph of production sources', () => {
    // Importing the SDK builds ~2.7k zod schemas (~9 MB per process). Every
    // session runner reaches the ACP corridor statically, while only ACP
    // sessions open a connection, so production code loads it via loadAcpSdk().
    const offenders = listProductionSources(SRC_ROOT)
      .filter((path) => SDK_VALUE_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC_ROOT, path));

    expect(offenders).toEqual([]);
  });
});

describe('loadAcpSdk', () => {
  it('retries after a failed load instead of caching the failure', async () => {
    vi.resetModules();
    vi.doMock('@agentclientprotocol/sdk', () => {
      throw new Error('simulated SDK load failure');
    });
    const { loadAcpSdk } = await import('../acpSdk');
    await expect(loadAcpSdk()).rejects.toThrow();

    vi.doUnmock('@agentclientprotocol/sdk');
    vi.resetModules();
    await expect(loadAcpSdk()).resolves.toHaveProperty('RequestError');
  });
});

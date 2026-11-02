import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveComputerProvider } from './provider';

const boundary = vi.hoisted(() => ({ home: '' }));
// Configuration is the environment boundary; installed-byte validation stays real.
vi.mock('@/configuration', async importOriginal => {
  const original = await importOriginal<typeof import('@/configuration')>();
  return { ...original, configuration: { ...original.configuration, get happyHomeDir() { return boundary.home; } } };
});
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'computer-provider-test-')); boundary.home = home; });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

async function installFixture(key: string, executable: string, version: string) {
  const root = join(home, 'tools', key, 'current');
  await mkdir(root, { recursive: true });
  const bytes = Buffer.from('native-boundary-fixture');
  await writeFile(join(root, executable), bytes);
  await chmod(join(root, executable), 0o755);
  await writeFile(join(root, '.happier-managed-version'), version);
  await writeFile(join(root, '.happier-managed-executable-sha256'), `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  return join(root, executable);
}

describe('computer provider admission', () => {
  it('chooses the installed default or an enabled explicit provider through one owner', async () => {
    const cuaPath = await installFixture('computer-cua-driver', process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver', '0.37.0');
    const agentPath = await installFixture('computer-agent-desktop', process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop', '1.0.2');
    const settings = { enabledProviders: ['cua', 'agent-desktop'], defaultProvider: 'cua' } as const;
    expect(await resolveComputerProvider({ settings })).toMatchObject({ provider: 'cua', executablePath: cuaPath });
    expect(await resolveComputerProvider({ settings, provider: 'agent-desktop' })).toMatchObject({ provider: 'agent-desktop', executablePath: agentPath });
  });
  it('refuses a disabled explicit provider and a missing install with the install hint, without falling through', async () => {
    const settings = { enabledProviders: ['cua'], defaultProvider: 'cua' } as const;
    await expect(resolveComputerProvider({ settings, provider: 'agent-desktop' })).rejects.toMatchObject({
      code: 'computer_provider_unavailable', provider: 'agent-desktop', installableKey: 'computer-agent-desktop',
    });
    await expect(resolveComputerProvider({ settings })).rejects.toMatchObject({
      code: 'computer_provider_unavailable', provider: 'cua', installableKey: 'computer-cua-driver',
    });
  });
});

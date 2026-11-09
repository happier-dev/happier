import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { resolveManagedToolsRoot } from '../agents/managedToolsRoot';
import { resolveFirstPartyInstallLayout } from './installLayout';
import { applyPersistedManagedToolsRoot, resolveSeparateUserToolsLayout } from './managedToolsLayout';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('selects code outside the personal home, persists only its location and activates it at startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-personal-tools-'));
  roots.push(root);
  const home = join(root, 'custodian');
  const happyHomeDir = join(home, '.happier');
  mkdirSync(happyHomeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home, HAPPIER_HOME_DIR: happyHomeDir };
  const cli = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
  const layout = resolveSeparateUserToolsLayout({ env, machineStateRoot: join(root, 'state') });
  expect(layout.toolsRoot.startsWith(join(root, 'state') + '/')).toBe(true);
  expect(layout.persistence?.path).toBe(join(happyHomeDir, 'install-layout.json'));
  expect(resolveManagedToolsRoot(env)).toBe(join(happyHomeDir, 'tools'));
  if (!layout.persistence) throw new Error('Personal setup must persist the location');
  writeFileSync(layout.persistence.path, layout.persistence.content, { mode: 0o600 });
  // The reviewed setup does not redirect the running daemon. A new startup
  // reads the location once; tool consumers share the resulting environment.
  const restarted = { ...env };
  applyPersistedManagedToolsRoot({ env: restarted, happyHomeDir, platform: 'linux' });
  expect(resolveManagedToolsRoot(restarted)).toBe(layout.toolsRoot);
  expect(resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: restarted })).toEqual(cli);
  writeFileSync(layout.persistence.path, '{}');
  expect(resolveManagedToolsRoot(restarted)).toBe(layout.toolsRoot);
});

it('keeps a managed guest on its existing external tools root without a personal layout file', () => {
  const layout = resolveSeparateUserToolsLayout({ machineStateRoot: '/var/lib/happier',
    env: { HOME: '/home/happier', HAPPIER_HOME_DIR: '/home/happier/.happier', HAPPIER_FIRST_PARTY_INSTALL_HOME: '/opt/happier' } });
  expect(layout).toEqual({ toolsRoot: '/opt/happier/tools' });
});

it.each(['darwin', 'win32'] as const)('does not activate Linux conversion on %s', platform => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/alice', HAPPIER_HOME_DIR: '/home/alice/.happier' };
  applyPersistedManagedToolsRoot({ env, happyHomeDir: env.HAPPIER_HOME_DIR!, platform });
  expect(env).not.toHaveProperty('HAPPIER_MANAGED_TOOLS_ROOT');
});

it.each(['{}', '{bad json', JSON.stringify({ managedToolsRoot: '/home/alice/.happier/tools' }),
  JSON.stringify({ managedToolsRoot: 'relative/tools' })])('leaves an invalid private location unavailable: %s', content => {
  const root = mkdtempSync(join(tmpdir(), 'happier-invalid-tools-'));
  roots.push(root);
  writeFileSync(join(root, 'install-layout.json'), content);
  const env: NodeJS.ProcessEnv = { HOME: '/home/alice', HAPPIER_HOME_DIR: '/home/alice/.happier' };
  applyPersistedManagedToolsRoot({ env, happyHomeDir: root, platform: 'linux' });
  expect(env).not.toHaveProperty('HAPPIER_MANAGED_TOOLS_ROOT');
});

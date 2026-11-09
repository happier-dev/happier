import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInstalledFirstPartyComponentPaths } from '../../firstPartyRuntime/resolveInstalledComponentPaths.js';
import { writeDefaultManagedReleaseChannel } from '../../firstPartyRuntime/defaultReleaseChannelState.js';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY } from '../../firstPartyRuntime/installLayout.js';
import type { HappierInstallation, HappierService } from '../types.js';
import { buildCliUninstallPlan } from './cliUninstall.js';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('CLI uninstall service selection', () => {
  it.each(['preview', 'stable'] as const)('matches owned aliases and pinned versions when the default is %s', async (defaultChannel) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-uninstall-matching-'));
    homes.push(home);
    const processEnv = { ...process.env, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: home };
    await writeDefaultManagedReleaseChannel({ releaseChannel: defaultChannel, processEnv });
    const preview = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'preview', processEnv });
    const stable = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv });
    const installation: HappierInstallation = {
      id: 'preview', source: 'firstPartyManaged', components: ['happier-cli', 'happier-daemon'], ring: 'preview', version: '0.3.0',
      path: preview.currentPath, realPath: join(preview.versionsDir, '0.3.0'), managedRoot: preview.installRoot, shimName: 'hprev', onPath: true,
    };
    const executables = [preview.shimPaths[0]!, stable.shimPaths[0]!, join(preview.versionsDir, '0.2.17', 'happier'), stable.binaryPath];
    const services: HappierService[] = executables.map((executablePath, index) => ({
      id: String(index), serviceType: 'daemon', platform: 'linux', backend: 'systemd-user', label: `happier-daemon.${index}`, verification: 'verified',
      ring: null, instanceId: String(index), scope: 'user', definitionPath: join(home, `${index}.service`), executablePath, installed: true, running: false,
    }));
    const plan = buildCliUninstallPlan({ selectedInstallation: installation, services, keepService: false });
    expect(plan.kind).toBe('managed-installation');
    if (plan.kind !== 'managed-installation') throw new Error('Expected managed removal');
    expect(plan.serviceTargets.map((service) => service.id)).toEqual(defaultChannel === 'preview' ? ['0', '1', '2'] : ['0', '2']);
    const keepPlan = buildCliUninstallPlan({ selectedInstallation: installation, services, keepService: true });
    expect(keepPlan).toMatchObject({ serviceTargets: [] });
  });
});

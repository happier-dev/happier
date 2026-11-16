import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveSelectedBuiltInContributions } from '@/plugins/projection/registry/selected';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

describe('Custom ACP requester native home', () => {
  it('prepares distinct empty homes without importing the custodian home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-acp-requester-home-'));
    const nativeHome = join(root, 'native');
    await mkdir(nativeHome);
    await writeFile(join(nativeHome, 'custodian-login'), 'private-fixture');
    const contributes = createResolvedContributionRegistry(resolveSelectedBuiltInContributions({
      agentIdentity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
    }));
    const runtime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { contributes, pluginIds: ['happier.agent.custom-acp'],
        scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } },
    });
    const materials: Array<NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>> = [];
    try {
      for (const materializationKey of ['first-requester', 'second-requester']) {
        const material = await materializeConnectedServicesForSpawn({
          agentId: 'custom-acp', materializationKey,
          activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
          recordsByServiceId: new Map(), allowNativeAccountState: false,
          processEnv: { HOME: nativeHome, USERPROFILE: nativeHome },
        });
        expect(material).not.toBeNull();
        if (!material) throw new Error('Requester native home missing');
        materials.push(material);
        expect(material.env.HOME).toBe(material.targetMaterializedRoot);
        expect(material.env.HOME).not.toBe(nativeHome);
        expect(await readdir(material.env.HOME!)).not.toContain('custodian-login');
      }
      expect(materials[0]!.env.HOME).not.toBe(materials[1]!.env.HOME);
      expect(await readFile(join(nativeHome, 'custodian-login'), 'utf8')).toBe('private-fixture');
    } finally {
      for (const material of materials) await material.cleanupOnExit?.();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

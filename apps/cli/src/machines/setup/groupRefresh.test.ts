import { describe, expect, it } from 'vitest';
import { getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import { resolveDaemonServiceSystemdUnitName, resolveDaemonServiceLaunchdLabel } from '@/daemon/service/plan';

const unit = resolveDaemonServiceSystemdUnitName('default', 'stable', 'default-following');

// Only catalog content, the account store and native OS reads are supplied.
// Declaration resolution, group observation, lifecycle projection and Plan stay real.
describe('Software group refresh review', () => {
  async function plan(mode: 'user' | 'system' | 'unknown', member = false, username = 'happier', stale = false, userDeclaration = false) {
    const pluginId = 'com.example.group-tools';
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Tools',
      runtime: { apiVersion: 1 }, contributes: { machineRecipes: [{ id: 'engine', revision: '1', title: 'Engine', software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: userDeclaration ? [{ id: 'engine-access', kind: 'user', username, home: '/changed-home', supplementaryGroups: ['docker'] }]
          : [{ id: 'engine-access', kind: 'group', name: 'docker', members: [username] }],
      }] } });
    const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({ provenance: 'external', loadResult: {
      loadedPlugins: [{ pluginId, pluginRootPath: '/plugins/tools', manifestPath: '/plugins/tools/plugin.json', daemonEntryPath: null,
        devDaemonEntryPath: null, sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest }],
      diagnosticsByPluginId: {},
    } }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Plan cannot mutate'); },
    });
    return prepareMachineSetupPlanV1({ current,
      input: { homeId: 'home', machineId: 'guest', mode: 'effects', sources: [{ kind: 'direct', setup: { items: [{
        kind: 'softwareRecipe', selection: { ref: { pluginId, recipeId: 'engine', revision: '1' }, inputs: {} },
      }] } }] },
      readRecipes: async () => Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById),
      runNative: async ({ executable, args }) => {
        if (executable === 'getent') return { code: 0, stdout: args[1] === 'group'
          ? `docker:x:109:${member ? username : ''}\n` : `${username}:x:1000:1000::/home/${username}:/bin/bash\n`, stderr: '' };
        if (executable === 'id') return { code: 0, stdout: member ? '1000 109\n' : '1000\n', stderr: '' };
        if (executable === 'systemctl') return { code: 0, stdout: 'MainPID=27\nActiveState=active\n', stderr: '' };
        if (executable === 'cat') return { code: 0, stdout: `Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t${member && !stale ? '1000 109' : '1000'}\n`, stderr: '' };
        throw new Error(`Plan attempted native effect: ${executable}`);
      },
      groupRefreshNative: { platform: 'linux', user: { username: 'happier', uid: 1000 },
        groups: member && !stale ? [1000, 109] : [1000],
        serviceLabel: resolveDaemonServiceLaunchdLabel('default', 'stable', 'default-following'), readCgroup: async () => {
          if (mode === 'unknown') throw new Error('Native cgroup unavailable');
          return mode === 'user' ? `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`
            : `0::/happier-critical.slice/${unit}\n`;
        } },
    });
  }

  it.each(['user', 'system'] as const)('discloses the required %s-service refresh before granting Engine access', async mode => {
    expect(await plan(mode)).toMatchObject({ review: { downtime: 'possible', requiresSessionRefresh: {
      kind: 'requiresSessionRefresh', username: 'happier', requiresAdministrator: true,
      scope: mode === 'user' ? 'userServices' : 'daemonService',
      command: { executable: 'systemctl', args: ['restart', ...(mode === 'user' ? ['--', 'user@1000.service'] : [unit])] },
    } } });
  });

  it('does not require a daemon refresh for an unchanged membership or another account', async () => {
    for (const result of [await plan('user', true), await plan('user', false, 'other')]) {
      expect(result).not.toHaveProperty('review.requiresSessionRefresh');
    }
  });

  it('keeps a completed group grant pending while the daemon still has its old kernel groups', async () => {
    expect(await plan('user', true, 'happier', true)).toHaveProperty('review.requiresSessionRefresh.kind', 'requiresSessionRefresh');
  });
  it('distinguishes a user group grant from an unrelated user-home change with already usable groups', async () => {
    expect(await plan('user', false, 'happier', false, true)).toHaveProperty('review.requiresSessionRefresh.kind', 'requiresSessionRefresh');
    expect(await plan('user', true, 'happier', false, true)).not.toHaveProperty('review.requiresSessionRefresh');
  });
  it('names a fresh login when the service lifecycle cannot be observed', async () => {
    const result = await plan('unknown');
    expect(result).toMatchObject({ review: { requiresSessionRefresh: {
      kind: 'requiresSessionRefresh', scope: 'loginSession', username: 'happier', requiresAdministrator: false,
    } } });
    expect(result).not.toHaveProperty('review.requiresSessionRefresh.command');
  });
});

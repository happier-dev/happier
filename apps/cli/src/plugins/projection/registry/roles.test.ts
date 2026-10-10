import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginProjectionV2Schema, resolveRoleSelectionV1 } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import { createResolvedContributionRegistry, createMergedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { readPluginRoleSources } from './roles';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const role = {
    id: 'reviewer', name: 'Security reviewer', instructions: 'Review security boundaries.',
    engine: { agentTargetKey: 'agent:codex', effort: 'high' },
    runsAs: { kind: 'background_run' as const, intent: 'review' as const },
    workspaceWrites: 'deny' as const, secondOpinion: 'off' as const, enabled: true,
};

function loaded(pluginId: string): LoadedPlugin {
    const root = `/plugins/${pluginId}`;
    return {
        pluginId, pluginRootPath: root, manifestPath: `${root}/plugin.json`,
        daemonEntryPath: null, devDaemonEntryPath: null,
        sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: normalizePluginManifestV2({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: { key: 'plugin.name', fallback: 'Roles' },
            runtime: { apiVersion: 1 }, contributes: { roles: [role, { ...role, id: 'disabled', enabled: false }] },
        }),
    };
}

describe('plugin roles through the canonical projection', () => {
    it('admits a roles-only plugin without a daemon entrypoint through the runtime occurrence owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-roles-'));
        const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [loaded('com.acme.security')], diagnosticsByPluginId: {} }, provenance: 'first_party',
        }));
        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir, contributes, generation: 1,
            generationAuthority: { commit: null, generations: new Map(), rejectedGenerations: new Map(), isCurrent: async () => true },
        });
        try {
            expect(readPluginRoleSources(registry.contributes).map((entry) => entry.localId)).toEqual(['disabled', 'reviewer']);
            expect(buildPluginProjectionV2({ registry: registry.contributes, generation: 1 }).familiesById.roles?.entriesById)
                .toHaveProperty(['com.acme.security/reviewer']);
            registry.fencePluginConsumers?.(['com.acme.security']);
            expect(readPluginRoleSources(registry.contributes)).toEqual([]);
            expect(buildPluginProjectionV2({ registry: registry.contributes, generation: 1 }).familiesById.roles?.entriesById)
                .toEqual({});
        } finally {
            await registry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('feeds namespaced, read-only role sources and per-field overrides without activating plugin code', async () => {
        const pluginIds = ['com.acme.security', 'com.acme.other'];
        // These declarations have no cross-plugin references. The built-in
        // projection path exercises the same role normalizer without requiring
        // separately published bundled-package artifacts on a source-test host.
        const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: pluginIds.map(loaded), diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const registry = createResolvedContributionRegistry({ ...inputs,
            occurrenceIdsByPluginId: Object.fromEntries(pluginIds.map((id) => [id, createPluginRuntimeOccurrenceId(id)])),
        });
        const projection = buildPluginProjectionV2({ registry, generation: 1 });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        expect(projection.installedPackagesById['com.acme.security']?.displayName).toBe('Roles');
        expect(projection.familiesById.roles?.entriesById['com.acme.security/reviewer']).toMatchObject({
            pluginId: 'com.acme.security', definition: role,
        });
        const sources = await createRoleSourceReader({ readPluginRoles: () => readPluginRoleSources(registry) })();
        const pluginEntries = sources.filter((entry) => entry.roleId.startsWith('plugin:'));
        expect(pluginEntries.map((entry) => entry.roleId)).toEqual([
            'plugin:com.acme.other/disabled', 'plugin:com.acme.other/reviewer',
            'plugin:com.acme.security/disabled', 'plugin:com.acme.security/reviewer',
        ]);
        expect(pluginEntries.every((entry) => entry.viewOnly)).toBe(true);
        expect(pluginEntries.every((entry) => entry.pluginDisplayName === 'Roles')).toBe(true);
        const roleId = 'plugin:com.acme.security/reviewer';
        expect(resolveRoleSelectionV1({ roleId, pluginRoles: readPluginRoleSources(registry), settingsOverrides: {
            [roleId]: { roleId, instructionsOverride: 'Account review instructions.', engine: { agentTargetKey: 'agent:claude' } },
        } })).toMatchObject({ ok: true, selection: {
            instructions: 'Account review instructions.', engine: { agentTargetKey: 'agent:claude' },
            runsAs: role.runsAs, workspaceWrites: 'deny', changedAt: 'settings',
        } });
        expect(resolveRoleSelectionV1({ roleId: 'plugin:com.acme.security/disabled', pluginRoles: readPluginRoleSources(registry) }))
            .toMatchObject({ ok: false, refusal: { code: 'role_target_unavailable' } });

        // No current occurrence (disabled or removed installation) withdraws the role;
        // an Account override cannot recreate its source instructions.
        const withdrawn = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} });
        expect(readPluginRoleSources(withdrawn)).toEqual([]);
        expect(buildPluginProjectionV2({ registry: withdrawn, generation: 2 }).familiesById.roles?.entriesById).toEqual({});
        expect(resolveRoleSelectionV1({ roleId, pluginRoles: readPluginRoleSources(withdrawn), settingsOverrides: {
            [roleId]: { roleId, engine: { agentTargetKey: 'agent:claude' } },
        } })).toMatchObject({ ok: false, refusal: { code: 'role_target_unavailable' } });
        const uninstalled = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: { loadedPlugins: [], diagnosticsByPluginId: {} }, provenance: 'first_party' }));
        expect(readPluginRoleSources(uninstalled)).toEqual([]);
        const merged = createMergedContributionRegistry({ roles: registry.roles }, {});
        expect(merged.roles).toEqual(registry.roles);
    });
});

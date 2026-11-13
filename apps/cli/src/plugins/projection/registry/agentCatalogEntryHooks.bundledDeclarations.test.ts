import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginManifest } from '@happier-dev/protocol/plugins/manifest';

import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from './sources/generatedBundledPluginManifests';
import { projectAgentConnectedAccountLaunchCatalogEntry } from './agentCatalogEntryHooks';

describe('bundled Agent launch declaration consistency', () => {
    it.each(BUNDLED_FIRST_PARTY_PLUGIN_METADATA.filter(entry => entry.agentId))(
        '$pluginPackageId admits its registered launch facts and coherent sharing support',
        async ({ pluginPackageId }) => {
            const sourceRoot = fileURLToPath(new URL(`../../../../../../packages/plugins/${pluginPackageId}/src/`, import.meta.url));
            type ActivationModule = Parameters<typeof createPluginTestkit>[0]['module'];
            const authored = await import(`${sourceRoot}manifest.ts`) as { PLUGIN_MANIFEST: PluginManifest } & Partial<ActivationModule>;
            const { PLUGIN_MANIFEST } = authored;
            const module = authored.activate ? { activate: authored.activate } : await import(`${sourceRoot}activate.ts`) as ActivationModule;
            const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module });
            try {
                const admittedKeys = new Set([...(PLUGIN_MANIFEST.hostAccess?.required ?? []),
                    ...(PLUGIN_MANIFEST.hostAccess?.optional ?? [])].flatMap(request =>
                    request.capability === 'process' ? request.scope.envKeys ?? []
                        : request.capability === 'environment' ? request.scope.keys : [],
                ).map(key => key.toLowerCase()));
                for (const agent of PLUGIN_MANIFEST.contributes.agents ?? []) {
                    for (const key of agent.providerRequirements?.authIsolation.ownedEnvKeys ?? []) {
                        expect(admittedKeys.has(key.toLowerCase()), `Provider environment ${key}`).toBe(true);
                    }
                    const launch = activation.registration('agents', agent.id)?.connectedAccountLaunch;
                    if (!launch) continue;
                    // Exercise the actual host admission owner, rather than copying its key rules.
                    expect(() => projectAgentConnectedAccountLaunchCatalogEntry({
                        pluginId: PLUGIN_MANIFEST.id, agentId: agent.id,
                        connectedAccountLaunch: launch, hostAccess: PLUGIN_MANIFEST.hostAccess,
                        isCurrent: () => true,
                    })).not.toThrow();
                    for (const use of launch.environmentUnsetUses ?? []) {
                        expect(admittedKeys.has(use.environmentKey.toLowerCase()), `Launch unset ${use.environmentKey}`).toBe(true);
                    }
                    const sharing = launch.stateSharingDescriptor;
                    for (const section of [sharing?.config, sharing?.state]) {
                        if (section?.supported) expect(section.unavailableReason).toBeUndefined();
                    }
                }
            } finally {
                await activation.dispose();
            }
        },
    );
});

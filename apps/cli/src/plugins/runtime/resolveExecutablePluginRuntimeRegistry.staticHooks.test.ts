import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
    ResolvedContributionRegistry,
    ResolvedActivatedHookRegistration,
} from '@/plugins/projection/registry/types';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('executable plugin hook activation ownership', () => {
    it('does not import or bind a manifest-static hook export outside named activation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-static-hook-deny-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'globalThis.__HAPPIER_STATIC_HOOK_IMPORTED = true;',
            'export async function legacyHook() { return { decision: "abstain" }; }',
        ].join('\n'), 'utf8');
        const registration: ResolvedActivatedHookRegistration = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.static-hook',
            manifestPath: join(root, 'happier.plugin.json'),
            manifestDigest: 'sha256:static-hook',
            daemonEntryPath,
            sourceSpec: {
                kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link',
            },
            definition: {
                hookApiVersion: 1,
                id: 'agent.resolvePrerequisites',
                category: 'decision',
                scope: 'agent',
                executionKind: 'decide',
            },
        };
        const contributes = {
            uiViewsV2: [], uiRenderersV2: [], uiTranslationsV2: [],
            agents: [], actions: [], tools: [], commands: [], resources: [],
            activationTargets: [], hookRegistrations: [registration],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const globalWithMarker = globalThis as typeof globalThis & {
            __HAPPIER_STATIC_HOOK_IMPORTED?: boolean;
        };
        delete globalWithMarker.__HAPPIER_STATIC_HOOK_IMPORTED;

        try {
            const runtime = await resolveExecutablePluginRuntimeRegistry({
                contributes,
                generation: 1,
            });

            expect(globalWithMarker.__HAPPIER_STATIC_HOOK_IMPORTED).toBeUndefined();
            expect(runtime.hookHandlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
            await runtime.dispose();
        } finally {
            delete globalWithMarker.__HAPPIER_STATIC_HOOK_IMPORTED;
        }
    });
});

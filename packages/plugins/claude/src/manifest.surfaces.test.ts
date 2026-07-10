import { describe, expect, it } from 'vitest';
import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/plugin-sdk/manifest';

import * as pluginModule from './index.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function getClaudeBackend() {
    const backend = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'claude');
    if (!backend) {
        throw new Error('Expected Claude plugin manifest to declare claude backend contribution');
    }
    return backend;
}

describe('Claude session surface declarations', () => {
    it('declares daemon spawn prerequisite and env augmentation hooks', () => {
        expect(PLUGIN_MANIFEST.uses).toContain('hooks');
        expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
            expect.objectContaining({
                id: 'agent.resolvePrerequisites',
                filters: { agentId: 'claude' },
                handler: expect.objectContaining({
                    target: 'plugin',
                    exportName: 'resolveClaudeDaemonSpawnPrerequisites',
                }),
            }),
            expect.objectContaining({
                id: 'agent.spawnEnv.augment',
                filters: { agentId: 'claude' },
                handler: expect.objectContaining({
                    target: 'plugin',
                    exportName: 'augmentClaudeDaemonSpawnEnv',
                }),
            }),
        ]);
    });

    it('declares the macOS security keychain system tool used by native auth materialization', () => {
        expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual({
            toolId: 'claude.macos.security',
            displayName: 'macOS Keychain security',
            source: 'system',
            lookupNames: ['security'],
            defaultArgs: [],
        });
    });

    it('declares plugin-owned external-session and handoff handlers exported by the bundled plugin entrypoint', () => {
        const handlers = getClaudeBackend().surfaceHandlers ?? [];
        const catalog = BackendSurfaceOperationCatalogV1;

        expect(handlers).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.resolveSource,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.listCandidates,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.getActivity,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.pageTranscript,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.readAfterTranscript,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.acquireFollowLease,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.resolveLinkIdentity,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.resolveLinkedIdentity,
            }),
            expect.objectContaining({
                kind: 'externalSession',
                operation: catalog.externalSession.resolveTakeoverLaunch,
            }),
            expect.objectContaining({
                kind: 'handoff',
                operation: catalog.handoff.exportBundle,
                handler: expect.objectContaining({
                    target: 'daemon',
                    exportName: 'exportClaudeSessionBundle',
                }),
            }),
            expect.objectContaining({
                kind: 'handoff',
                operation: catalog.handoff.importBundle,
                handler: expect.objectContaining({
                    target: 'daemon',
                    exportName: 'importClaudeSessionBundle',
                }),
            }),
        ]));

        for (const handler of handlers) {
            const exportName = handler.handler.exportName;
            if (!exportName) continue;
            expect(pluginModule).toHaveProperty(exportName);
            expect(Reflect.get(pluginModule, exportName)).toEqual(expect.any(Function));
        }
    });

    it('declares the Claude external-session source schema and source-key rules in the backend manifest surface', () => {
        expect(getClaudeBackend().surfaces?.externalSession?.sources).toEqual([
            {
                sourceKind: 'claudeConfig',
                schema: {
                    passthrough: true,
                    fields: [
                        { name: 'kind', kind: 'literal', value: 'claudeConfig' },
                        { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
                        { name: 'projectId', kind: 'string', min: 1, max: 2_000, nullish: true },
                    ],
                },
                key: {
                    segments: [
                        { kind: 'literal', value: 'claudeConfig' },
                        { kind: 'field', field: 'configDir' },
                        { kind: 'field', field: 'projectId' },
                    ],
                },
            },
        ]);
    });
});

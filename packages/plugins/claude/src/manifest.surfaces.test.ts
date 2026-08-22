import { describe, expect, it } from 'vitest';

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
        expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
            expect.objectContaining({
                id: 'resolve-prerequisites',
                on: 'agent.resolvePrerequisites',
                filters: { agentId: 'claude' },
                executionKind: 'decide',
            }),
            expect.objectContaining({
                id: 'augment-spawn-env',
                on: 'agent.spawnEnv.augment',
                filters: { agentId: 'claude' },
                executionKind: 'augment',
            }),
        ]);
    });

    it('declares the macOS security keychain system tool used by native auth materialization', () => {
        expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual({
            id: 'macos-security',
            title: 'macOS Keychain security',
            executableNames: ['security'],
        });
    });

    it('keeps handoff bundle leaves in the plugin module without the retired takeover carrier', () => {
        expect(getClaudeBackend()).not.toHaveProperty('surfaceHandlers');
        for (const exportName of [
            'exportClaudeSessionBundle',
            'importClaudeSessionBundle',
        ]) {
            expect(pluginModule).toHaveProperty(exportName);
            expect(Reflect.get(pluginModule, exportName)).toEqual(expect.any(Function));
        }
        expect(pluginModule).not.toHaveProperty(
            'resolveClaudeExternalSessionTakeoverLaunch',
        );
        expect(pluginModule).not.toHaveProperty(
            'resolveClaudeExternalSessionTakeoverSpawnPlan',
        );
    });

    it('declares the Claude external-session source schema and source-key rules in the backend manifest surface', () => {
        expect(getClaudeBackend().surfaces?.externalSession?.sources).toEqual([
            {
                sourceKind: 'claudeConfig',
                schema: {
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
                instances: [{ kind: 'default', constants: {} }],
            },
        ]);
    });
});

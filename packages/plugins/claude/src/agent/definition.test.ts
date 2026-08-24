import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('AGENT_DEFINITION', () => {
    it('keeps strict CLI/auth authority in the native manifest', () => {
        expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
            executable: { binaryName: 'claude' },
            auth: { machineLoginKey: 'claude-code' },
        });
        expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
        const legacyRuntimeKey = 'provider' + 'CliRuntime';
        expect(legacyRuntimeKey in AGENT_DEFINITION).toBe(false);
    });

    it('authors Claude model facts in the plugin definition', () => {
        expect(AGENT_DEFINITION.modelConfig.staticModels?.[0]).toMatchObject({
            id: 'claude-opus-5',
            name: 'Opus 5',
            contextWindowTokens: 1_000_000,
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                }),
            ]),
        });
    });

    it('declares its catalog contribution from the static contribution leaf', () => {
        expect(AGENT_DEFINITION.runtimeContributions?.agentCatalogEntry).toEqual({
            importName: 'CLAUDE_AGENT_RUNTIME_CONTRIBUTION',
            source: './agent/contributions/catalog',
        });
    });
});

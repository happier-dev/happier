import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('AGENT_DEFINITION', () => {
    it('uses final agent CLI runtime vocabulary instead of legacy provider runtime vocabulary', () => {
        expect(AGENT_DEFINITION.agentCliRuntime).toEqual(expect.objectContaining({
            id: 'claude',
        }));
        const legacyRuntimeKey = 'provider' + 'CliRuntime';
        expect(legacyRuntimeKey in AGENT_DEFINITION).toBe(false);
    });

    it('authors Claude model facts in the plugin definition', () => {
        expect(AGENT_DEFINITION.modelConfig.staticModels?.[0]).toMatchObject({
            id: 'claude-fable-5',
            name: 'Fable 5',
            contextWindowTokens: 1_000_000,
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                }),
            ]),
        });
    });
});

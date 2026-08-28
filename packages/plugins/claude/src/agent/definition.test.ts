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

    it('keeps the public Agent definition free of private runtime aggregates', () => {
        expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
    });

    it('does not advertise check-now recovery without an executable control', () => {
        expect(AGENT_DEFINITION.core.sessionCapabilities.usageLimitRecovery).toEqual({
            checkNow: 'unsupported',
        });
        expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities.sessions?.usageLimitRecovery)
            .toBeUndefined();
    });
});

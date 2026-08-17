import { describe, expect, it } from 'vitest';

import { isPluginEventAutomationExecutionRunCapabilityCurrent } from './pluginEventAutomationExecutionCapability';

describe('isPluginEventAutomationExecutionRunCapabilityCurrent', () => {
    it('accepts only the exact detached task backend advertised by the current capability response', () => {
        const capability = {
            protocolVersion: 2,
            features: {
                detachedScope: true,
                startAndWait: true,
            },
            backends: {
                codex: { available: true, intents: ['task'] },
                claude: { available: true, intents: ['review'] },
            },
        };

        expect(isPluginEventAutomationExecutionRunCapabilityCurrent({
            capability,
            backendTarget: { kind: 'backend', backendId: 'codex' },
        })).toBe(true);
        expect(isPluginEventAutomationExecutionRunCapabilityCurrent({
            capability,
            backendTarget: { kind: 'backend', backendId: 'claude' },
        })).toBe(false);
        expect(isPluginEventAutomationExecutionRunCapabilityCurrent({
            capability: {
                ...capability,
                features: { detachedScope: true, startAndWait: false },
            },
            backendTarget: { kind: 'backend', backendId: 'codex' },
        })).toBe(false);
    });
});

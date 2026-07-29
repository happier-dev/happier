import { describe, expect, it } from 'vitest';

import { buildVoiceSpawnUserAttemptId } from './voiceSpawnAttempt';

const baseVoiceToolAttempt = {
    surface: 'voice_tool',
    serverId: 'server-a',
    machineId: 'machine-a',
    directory: '/workspace',
    backendTarget: { kind: 'backend', backendId: 'claude' },
    modelSelection: null,
} as const;

describe('buildVoiceSpawnUserAttemptId', () => {
    it('uses one identity for semantically equivalent nested object key orders', () => {
        const left = buildVoiceSpawnUserAttemptId({
            surface: 'voice_home',
            requirements: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        github: { kind: 'native' },
                        slack: { kind: 'native' },
                    },
                },
            },
        });
        const right = buildVoiceSpawnUserAttemptId({
            surface: 'voice_home',
            requirements: {
                connectedServices: {
                    bindingsByServiceId: {
                        slack: { kind: 'native' },
                        github: { kind: 'native' },
                    },
                    v: 1,
                },
            },
        });

        expect(left).toBe(right);
    });

    it('keeps distinct semantic attempts separate when their former 32-bit fingerprints collide', () => {
        const left = buildVoiceSpawnUserAttemptId({
            ...baseVoiceToolAttempt,
            initialMessage: 'dsbabszibuhyps24ob',
            tag: null,
        });
        const right = buildVoiceSpawnUserAttemptId({
            ...baseVoiceToolAttempt,
            initialMessage: 'wlulyzixenkzyj2jg8',
            tag: null,
        });

        expect(left).not.toBe(right);
    });
});

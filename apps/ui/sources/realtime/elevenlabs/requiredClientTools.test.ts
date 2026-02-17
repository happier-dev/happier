import { describe, expect, it } from 'vitest';

describe('resolveElevenLabsRequiredClientTools', () => {
    it('omits disabled actions', async () => {
        const { resolveElevenLabsRequiredClientTools } = await import('./requiredClientTools');

        const state: any = {
            settings: {
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'session.message.send': {
                            enabled: true,
                            disabledSurfaces: ['voice_tool'],
                            disabledPlacements: [],
                        },
                    },
                },
            },
        };

        const tools = resolveElevenLabsRequiredClientTools(state);
        expect(tools.some((t) => t.name === 'sendSessionMessage')).toBe(false);
    });
});

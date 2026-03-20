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

    it('omits discovery guidance for unavailable tools from parameter descriptions', async () => {
        const { resolveElevenLabsRequiredClientTools } = await import('./requiredClientTools');

        const state: any = {
            settings: {
                voice: {
                    privacy: {
                        shareDeviceInventory: false,
                    },
                },
            },
        };

        const tools = resolveElevenLabsRequiredClientTools(state);
        const spawnSession = tools.find((t) => t.name === 'spawnSession');
        expect(spawnSession).toBeTruthy();
        expect(String((spawnSession as any)?.parameters?.properties?.host?.description ?? '')).not.toContain('listMachines');
        expect(String((spawnSession as any)?.parameters?.properties?.path?.description ?? '')).toContain('spawnSessionPicker');
    });

    it('uses the richer action input guidance as the tool description when available', async () => {
        const { resolveElevenLabsRequiredClientTools } = await import('./requiredClientTools');

        const tools = resolveElevenLabsRequiredClientTools({});
        const spawnSession = tools.find((tool) => tool.name === 'spawnSession');

        expect(spawnSession).toBeTruthy();
        expect(String(spawnSession?.description ?? '')).toContain('new session');
    });
});

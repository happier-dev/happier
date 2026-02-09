import { afterEach, describe, expect, it } from 'vitest';
import { getEffectiveServerSelection, getNewSessionServerTargeting, resolveNewSessionServerTarget } from './multiServer';
import { settingsDefaults } from './settings';

afterEach(() => {
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('multiServer selection', () => {
    it('falls back to active server when concurrent mode is disabled', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                multiServerEnabled: false,
                multiServerSelectedServerIds: ['server-b'],
                multiServerPresentation: 'grouped',
            },
        });

        expect(selection).toEqual({
            enabled: false,
            serverIds: ['server-a'],
            presentation: 'grouped',
        });
    });

    it('uses selected server IDs when concurrent mode is enabled', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-b', 'server-c'],
                multiServerPresentation: 'flat-with-badge',
            },
        });

        expect(selection).toEqual({
            enabled: true,
            serverIds: ['server-b', 'server-c'],
            presentation: 'flat-with-badge',
        });
    });

    it('prefers the active multi-server profile selection when available', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-a'],
                multiServerPresentation: 'grouped',
                multiServerProfiles: [
                    {
                        id: 'dev-work',
                        name: 'Dev Work',
                        serverIds: ['server-b', 'server-c'],
                        presentation: 'flat-with-badge',
                    },
                ],
                multiServerActiveProfileId: 'dev-work',
            } as any,
        });

        expect(selection).toEqual({
            enabled: true,
            serverIds: ['server-b', 'server-c'],
            presentation: 'flat-with-badge',
        });
    });

    it('falls back to legacy multi-server selection when active profile is missing', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-a', 'server-b'],
                multiServerPresentation: 'grouped',
                multiServerProfiles: [
                    {
                        id: 'dev-work',
                        name: 'Dev Work',
                        serverIds: ['server-b', 'server-c'],
                        presentation: 'flat-with-badge',
                    },
                ],
                multiServerActiveProfileId: 'missing',
            } as any,
        });

        expect(selection).toEqual({
            enabled: true,
            serverIds: ['server-a', 'server-b'],
            presentation: 'grouped',
        });
    });

    it('deduplicates and filters missing server IDs', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-b', 'server-b', 'missing'],
                multiServerPresentation: 'grouped',
            },
        });

        expect(selection.serverIds).toEqual(['server-b']);
    });

    it('falls back to active server when concurrent mode is enabled but no selection exists', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: [],
                multiServerPresentation: 'grouped',
            },
        });

        expect(selection.serverIds).toEqual(['server-a']);
    });

    it('accepts defaults from settings defaults', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a'],
            settings: {
                multiServerEnabled: settingsDefaults.multiServerEnabled as boolean,
                multiServerSelectedServerIds: settingsDefaults.multiServerSelectedServerIds as string[],
                multiServerPresentation: settingsDefaults.multiServerPresentation as 'grouped' | 'flat-with-badge',
            },
        });
        expect(selection.enabled).toBe(false);
        expect(selection.serverIds).toEqual(['server-a']);
    });

    it('disables concurrent mode when runtime flag is off', () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '0';
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-b'],
                multiServerPresentation: 'flat-with-badge',
            },
        });

        expect(selection).toEqual({
            enabled: false,
            serverIds: ['server-a'],
            presentation: 'flat-with-badge',
        });
    });

    it('new-session targeting only allows active server when concurrent mode is disabled', () => {
        const targeting = getNewSessionServerTargeting({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                multiServerEnabled: false,
                multiServerSelectedServerIds: ['server-b'],
                multiServerPresentation: 'grouped',
            },
        });

        expect(targeting).toEqual({
            allowedServerIds: ['server-a'],
            pickerEnabled: false,
        });
    });

    it('new-session targeting enables picker only when multiple selected servers are active', () => {
        const targeting = getNewSessionServerTargeting({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c'],
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-b', 'server-c'],
                multiServerPresentation: 'grouped',
            },
        });

        expect(targeting).toEqual({
            allowedServerIds: ['server-b', 'server-c'],
            pickerEnabled: true,
        });
    });

    it('rejects a requested new-session server outside the allowed set', () => {
        const resolved = resolveNewSessionServerTarget({
            requestedServerId: 'server-c',
            activeServerId: 'server-a',
            allowedServerIds: ['server-a', 'server-b'],
        });

        expect(resolved).toEqual({
            targetServerId: 'server-a',
            rejectedRequestedServerId: 'server-c',
        });
    });

    it('accepts requested new-session server when it is allowed', () => {
        const resolved = resolveNewSessionServerTarget({
            requestedServerId: 'server-b',
            activeServerId: 'server-a',
            allowedServerIds: ['server-a', 'server-b'],
        });

        expect(resolved).toEqual({
            targetServerId: 'server-b',
            rejectedRequestedServerId: null,
        });
    });
});

import { afterEach, describe, expect, it } from 'vitest';

import {
    getEffectiveServerSelection,
    getNewSessionServerTargeting,
    listServerSelectionTargets,
    resolveActiveServerSelection,
    resolveNewSessionServerTarget,
} from './serverSelectionResolver';

afterEach(() => {
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('serverSelectionResolver', () => {
    const serverProfiles = [
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test' },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test' },
        { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test' },
    ];

    const groupProfiles = [
        { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' as const },
    ];

    it('lists server targets with servers first and then groups', () => {
        const targets = listServerSelectionTargets({
            serverProfiles,
            groupProfiles,
        });

        expect(targets.map((target) => `${target.kind}:${target.id}`)).toEqual([
            'server:server-a',
            'server:server-b',
            'server:server-c',
            'group:grp-dev',
        ]);
    });

    it('resolves explicit group target and constrains active server to the group', () => {
        const resolved = resolveActiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: serverProfiles.map((profile) => profile.id),
            settings: {
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
                serverSelectionGroups: groupProfiles,
            },
        });

        expect(resolved.activeTarget.kind).toBe('group');
        expect(resolved.activeServerId).toBe('server-b');
        expect(resolved.allowedServerIds).toEqual(['server-b', 'server-c']);
        expect(resolved.enabled).toBe(true);
    });

    it('falls back to active server when no explicit target is configured', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                serverSelectionGroups: groupProfiles,
                serverSelectionActiveTargetKind: null,
                serverSelectionActiveTargetId: null,
            },
        });

        expect(selection).toEqual({
            enabled: false,
            serverIds: ['server-a'],
            presentation: 'grouped',
        });
    });

    it('disables group selection when runtime flag is off', () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '0';
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c'],
            settings: {
                serverSelectionGroups: groupProfiles,
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            },
        });

        expect(selection).toEqual({
            enabled: false,
            serverIds: ['server-a'],
            presentation: 'grouped',
        });
    });

    it('new-session targeting enables picker when group selection has multiple servers', () => {
        const targeting = getNewSessionServerTargeting({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c'],
            settings: {
                serverSelectionGroups: groupProfiles,
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
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
});

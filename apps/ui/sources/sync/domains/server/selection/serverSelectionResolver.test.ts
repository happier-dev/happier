import { afterEach, describe, expect, it } from 'vitest';

import {
    getEffectiveServerSelection,
    getNewSessionServerTargeting,
    listServerSelectionTargets,
    resolveActiveServerSelection,
    resolveNewSessionServerTarget,
} from './serverSelectionResolver';
import { ALL_HOMES_SELECTION_TARGET_ID } from './allHomesSelectionTarget';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { t } from '@/text';

afterEach(() => {
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('serverSelectionResolver', () => {
    it('gives unnamed peer Homes distinct visible picker labels', () => {
        const targets = listServerSelectionTargets({
            serverProfiles: [
                { id: 'home-a', name: 'home-a.example.test', serverUrl: 'https://home-a.example.test' },
                { id: 'home-b', name: 'home-b.example.test', serverUrl: 'https://home-b.example.test' },
            ],
            groupProfiles: [],
            currentServerId: 'home-a',
        });
        expect(targets.filter((target) => target.kind === 'server').map((target) => target.name))
            .toEqual([t('settingsAccount.thisHomeTitle'), 'https://home-b.example.test']);
    });

    it('uses the Home name for a selection whose saved label is its host', () => {
        const profile = { id: 'named-home', name: 'localhost:52753', serverUrl: 'http://localhost:52753' };
        primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            expect(listServerSelectionTargets({ serverProfiles: [profile], groupProfiles: [] }))
                .toMatchObject([{ kind: 'server', name: 'Studio Home' }]);
        } finally {
            deleteServerFeaturesSnapshot({ serverId: profile.id });
        }
    });
    const serverProfiles = [
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test' },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test' },
        { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test' },
    ];

    const groupProfiles = [
        { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' as const },
    ];

    it('lists All Homes first, then every Home, then the person\'s groups', () => {
        const targets = listServerSelectionTargets({
            serverProfiles,
            groupProfiles,
        });

        expect(targets.map((target) => `${target.kind}:${target.id}`)).toEqual([
            `group:${ALL_HOMES_SELECTION_TARGET_ID}`,
            'server:server-a',
            'server:server-b',
            'server:server-c',
            'group:grp-dev',
        ]);
    });

    it('offers no All Homes target to a device with one Home', () => {
        const targets = listServerSelectionTargets({
            serverProfiles: serverProfiles.slice(0, 1),
            groupProfiles: [],
        });

        expect(targets.map((target) => `${target.kind}:${target.id}`)).toEqual(['server:server-a']);
    });

    it('resolves an explicit All Homes selection to every available Home, grouped by Home', () => {
        const resolved = resolveActiveServerSelection({
            activeServerId: 'server-b',
            availableServerIds: serverProfiles.map((profile) => profile.id),
            settings: {
                serverSelectionGroups: groupProfiles,
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: ALL_HOMES_SELECTION_TARGET_ID,
            },
        });

        expect(resolved).toEqual({
            activeTarget: {
                kind: 'group',
                id: ALL_HOMES_SELECTION_TARGET_ID,
                groupId: ALL_HOMES_SELECTION_TARGET_ID,
                serverIds: ['server-a', 'server-b', 'server-c'],
            },
            activeServerId: 'server-b',
            allowedServerIds: ['server-a', 'server-b', 'server-c'],
            enabled: true,
            presentation: 'grouped',
            explicit: true,
        });
    });

    it('keeps an explicit All Homes selection following Homes added later', () => {
        const selection = getEffectiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a', 'server-b', 'server-c', 'server-d'],
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: ALL_HOMES_SELECTION_TARGET_ID,
            },
        });

        expect(selection.serverIds).toEqual(['server-a', 'server-b', 'server-c', 'server-d']);
        expect(selection.enabled).toBe(true);
    });

    it('falls back to the one Home when All Homes was chosen and only one Home is left', () => {
        const resolved = resolveActiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: ['server-a'],
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: ALL_HOMES_SELECTION_TARGET_ID,
            },
        });

        expect(resolved.activeTarget).toEqual({ kind: 'server', id: 'server-a', serverId: 'server-a' });
        expect(resolved.enabled).toBe(false);
    });

    describe('All Homes by default once this device can use two or more Homes', () => {
        const available = ['server-a', 'server-b', 'server-c'];
        const unset = { serverSelectionGroups: groupProfiles, serverSelectionActiveTargetKind: null, serverSelectionActiveTargetId: null };

        it('shows every Home this device can use together until the person picks a scope', () => {
            const resolved = resolveActiveServerSelection({
                activeServerId: 'server-a',
                availableServerIds: available,
                usableServerIds: ['server-a', 'server-b'],
                settings: unset,
            });
            expect(resolved.activeTarget).toEqual({
                kind: 'group', id: ALL_HOMES_SELECTION_TARGET_ID, groupId: ALL_HOMES_SELECTION_TARGET_ID, serverIds: ['server-a', 'server-b'],
            });
            expect(resolved.allowedServerIds).toEqual(['server-a', 'server-b']);
            expect(resolved.enabled).toBe(true);
            expect(resolved.explicit).toBe(false);
        });

        it('does not count a saved Home this device holds no credential for (a pre-saved Happier Cloud)', () => {
            const resolved = resolveActiveServerSelection({
                activeServerId: 'server-a',
                availableServerIds: ['server-a', 'server-b'],
                usableServerIds: ['server-a'],
                settings: unset,
            });
            expect(resolved.activeTarget).toEqual({ kind: 'server', id: 'server-a', serverId: 'server-a' });
            expect(resolved.enabled).toBe(false);
        });

        it('keeps one Home while it is not yet known which Homes this device can use', () => {
            const resolved = resolveActiveServerSelection({ activeServerId: 'server-a', availableServerIds: available, settings: unset });
            expect(resolved.activeTarget).toEqual({ kind: 'server', id: 'server-a', serverId: 'server-a' });
        });

        it('never overrides a scope the person chose', () => {
            const single = resolveActiveServerSelection({
                activeServerId: 'server-a',
                availableServerIds: available,
                usableServerIds: available,
                settings: { ...unset, serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'server-c' },
            });
            expect(single.activeTarget).toEqual({ kind: 'server', id: 'server-c', serverId: 'server-c' });
            const group = resolveActiveServerSelection({
                activeServerId: 'server-b',
                availableServerIds: available,
                usableServerIds: available,
                settings: { ...unset, serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'grp-dev' },
            });
            expect(group.activeTarget).toMatchObject({ kind: 'group', groupId: 'grp-dev' });
        });

        it('offers All Homes in the list only over Homes this device can use', () => {
            const targets = listServerSelectionTargets({
                serverProfiles: serverProfiles.slice(0, 2),
                groupProfiles: [],
                usableServerIds: ['server-a'],
            });
            expect(targets.map((target) => `${target.kind}:${target.id}`)).toEqual(['server:server-a', 'server:server-b']);
        });
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

    it('honors an explicit server target even when a different Home is focused', () => {
        const resolved = resolveActiveServerSelection({
            activeServerId: 'server-b',
            availableServerIds: ['server-a', 'server-b'],
            settings: {
                serverSelectionGroups: groupProfiles,
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-a',
            },
        });

        expect(resolved.activeTarget).toEqual({ kind: 'server', id: 'server-a', serverId: 'server-a' });
        expect(resolved.activeServerId).toBe('server-a');
        expect(resolved.allowedServerIds).toEqual(['server-a']);
        expect(resolved.explicit).toBe(true);
    });

    it('preserves the active server when no server profiles are available yet', () => {
        const resolved = resolveActiveServerSelection({
            activeServerId: 'server-a',
            availableServerIds: [],
            settings: {
                serverSelectionGroups: null,
                serverSelectionActiveTargetKind: null,
                serverSelectionActiveTargetId: null,
            },
        });

        expect(resolved).toEqual({
            activeTarget: { kind: 'server', id: 'server-a', serverId: 'server-a' },
            activeServerId: 'server-a',
            allowedServerIds: ['server-a'],
            enabled: false,
            presentation: 'grouped',
            explicit: false,
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
            targetServerId: null,
            rejectedRequestedServerId: 'server-c',
        });
    });

    it('preserves the rejected explicit target when no Home is currently available', () => {
        expect(resolveNewSessionServerTarget({
            requestedServerId: 'removed-home',
            activeServerId: 'server-a',
            allowedServerIds: [],
        })).toEqual({
            targetServerId: null,
            rejectedRequestedServerId: 'removed-home',
        });
    });
});

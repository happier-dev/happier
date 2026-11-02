import { describe, expect, it } from 'vitest';
import { resolveConcurrentTargets } from './concurrentSessionCache';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

describe('resolveConcurrentTargets', () => {
    it('uses the published Home name for remote session lists instead of the saved host', () => {
        primeServerFeaturesSnapshot({ serverId: 'server-c', snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            expect(resolveConcurrentTargets({
                activeServerId: 'server-a', profiles: [
                    { id: 'server-a', serverUrl: 'https://a.example.test', name: 'Server A' },
                    { id: 'server-c', serverUrl: 'http://localhost:52753', name: 'localhost:52753' },
                ], settings: { serverSelectionGroups: [{ id: 'group-main', name: 'Main', serverIds: ['server-a', 'server-c'], presentation: 'grouped' }],
                    serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'group-main' },
            })).toMatchObject([{ id: 'server-c', serverName: 'Studio Home' }]);
        } finally {
            deleteServerFeaturesSnapshot({ serverId: 'server-c' });
        }
    });
    const profiles = [
        { id: 'server-a', serverUrl: 'https://a.example.test', name: 'Server A' },
        { id: 'server-b', serverUrl: 'https://b.example.test', name: 'Server B' },
        { id: 'server-c', serverUrl: 'https://c.example.test', name: 'Server C' },
    ] as const;

    it('returns selected non-active server targets when active selection is a group', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        });
        expect(result).toEqual([
            {
                id: 'server-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('returns empty targets when active selection is a concrete server', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-a',
            },
        });
        expect(result).toEqual([]);
    });

    it('honors explicit active server target and ignores concurrent selection sets', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-b',
            } as any,
        });
        expect(result).toEqual([]);
    });

    it('honors explicit group target when resolving concurrent targets', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-b',
            profiles,
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-dev',
                        name: 'Dev',
                        serverIds: ['server-b', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-dev',
            } as any,
        });
        expect(result).toEqual([
            {
                id: 'server-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('never makes the active Home a secondary target when it is identified by its profile id and advertises a canonical address', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles: [
                {
                    id: 'server-a', serverUrl: 'http://a.localhost:3000', name: 'Server A', serverIdentityId: 'srv-a',
                    canonicalServerUrl: 'https://a.example.test',
                },
                { id: 'server-c', serverUrl: 'https://c.example.test', name: 'Server C', serverIdentityId: 'srv-c' },
            ],
            settings: {
                serverSelectionGroups: [{ id: 'group-main', name: 'Main', serverIds: ['srv-a', 'srv-c'], presentation: 'grouped' }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
            observedServerIds: ['srv-a'],
        });
        expect(result.map(target => target.id)).toEqual(['srv-c']);
    });

    it('returns targets keyed by stable server identity ids', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'srv-a',
            profiles: [
                { id: 'server-a', serverUrl: 'https://a.example.test', name: 'Server A', serverIdentityId: 'srv-a' },
                { id: 'server-c', serverUrl: 'https://c.example.test', name: 'Server C', serverIdentityId: 'srv-c' },
            ],
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        });
        expect(result).toEqual([
            {
                id: 'srv-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('uses the canonical Home URL as the secondary credential and reachability authority', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles: [
                profiles[0],
                {
                    id: 'server-b',
                    serverUrl: 'https://legacy-alias.example.test',
                    canonicalServerUrl: 'https://home-b.example.test',
                    name: 'Server B',
                },
            ],
            settings: {
                serverSelectionGroups: [{
                    id: 'group-main',
                    name: 'Main',
                    serverIds: ['server-a', 'server-b'],
                    presentation: 'grouped',
                }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        });

        expect(result).toEqual([{
            id: 'server-b',
            serverUrl: 'https://home-b.example.test',
            serverName: 'Server B',
            canonicalServerUrl: 'https://home-b.example.test',
        }]);
    });
});

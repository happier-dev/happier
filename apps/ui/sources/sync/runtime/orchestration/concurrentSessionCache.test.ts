import { describe, expect, it } from 'vitest';
import { resolveConcurrentTargets } from './concurrentSessionCache';

describe('resolveConcurrentTargets', () => {
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
});

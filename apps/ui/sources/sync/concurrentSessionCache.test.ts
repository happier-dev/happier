import { describe, expect, it } from 'vitest';
import { resolveConcurrentTargets } from './concurrentSessionCache';

describe('resolveConcurrentTargets', () => {
    const profiles = [
        { id: 'server-a', serverUrl: 'https://a.example.test', name: 'Server A' },
        { id: 'server-b', serverUrl: 'https://b.example.test', name: 'Server B' },
        { id: 'server-c', serverUrl: 'https://c.example.test', name: 'Server C' },
    ] as const;

    it('returns selected non-active server targets when multi-server mode is enabled', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-a', 'server-c'],
                multiServerPresentation: 'grouped',
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

    it('returns empty targets when multi-server mode is disabled', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                multiServerEnabled: false,
                multiServerSelectedServerIds: ['server-b'],
                multiServerPresentation: 'flat-with-badge',
            },
        });
        expect(result).toEqual([]);
    });
});

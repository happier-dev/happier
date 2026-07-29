import { describe, expect, it } from 'vitest';

import {
    materializePluginRuntimeAuthority,
    snapshotActivatedPluginRuntimeAuthority,
} from './runtimeAuthority';

describe('plugin runtime authority snapshots', () => {
    it('copies a bounded deterministic snapshot from the activated registry', () => {
        const snapshot = snapshotActivatedPluginRuntimeAuthority({
            permissionsByPluginId: new Map([[
                'happier.agent.acme',
                new Set(['session.hooks.control', 'process.spawn'] as const),
            ]]),
            runtimeCapabilitiesByPluginId: new Map([[
                'happier.agent.acme',
                new Set(['sessionHooks', 'agents']),
            ]]),
        }, 'happier.agent.acme');

        expect(snapshot).toEqual({
            permissions: ['process.spawn', 'session.hooks.control'],
            runtimeCapabilities: ['agents', 'sessionHooks'],
        });
        expect(materializePluginRuntimeAuthority(snapshot)).toMatchObject({
            permissions: new Set(['process.spawn', 'session.hooks.control']),
            capabilities: new Set([
                'process.spawn',
                'session.hooks.control',
                'agents',
                'sessionHooks',
            ]),
        });
    });

    it('does not manufacture authority when either activated projection is absent', () => {
        expect(snapshotActivatedPluginRuntimeAuthority({
            permissionsByPluginId: new Map(),
            runtimeCapabilitiesByPluginId: new Map(),
        }, 'happier.agent.acme')).toBeNull();
        expect(materializePluginRuntimeAuthority(null)).toEqual({
            permissions: new Set(),
            capabilities: new Set(),
        });
    });
});

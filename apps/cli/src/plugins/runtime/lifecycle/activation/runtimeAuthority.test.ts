import { describe, expect, it } from 'vitest';

import {
    materializePluginRuntimeAuthority,
    snapshotActivatedPluginRuntimeAuthority,
} from './runtimeAuthority';

describe('plugin runtime authority snapshots', () => {
    it('copies a bounded deterministic snapshot from the activated registry', () => {
    const snapshot = snapshotActivatedPluginRuntimeAuthority({
            runtimeCapabilitiesByPluginId: new Map([[
                'happier.agent.acme',
                new Set(['sessionHooks', 'agents']),
            ]]),
        }, 'happier.agent.acme');

        expect(snapshot).toEqual({
        runtimeCapabilities: ['agents', 'sessionHooks'],
    });
        expect(materializePluginRuntimeAuthority(snapshot)).toEqual({
            capabilities: new Set(['agents', 'sessionHooks']),
        });
    });

    it('does not manufacture authority when either activated projection is absent', () => {
        expect(snapshotActivatedPluginRuntimeAuthority({
            runtimeCapabilitiesByPluginId: new Map(),
        }, 'happier.agent.acme')).toBeNull();
        expect(materializePluginRuntimeAuthority(null)).toEqual({
            capabilities: new Set(),
        });
    });
});

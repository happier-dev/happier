import { describe, expect, it } from 'vitest';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';

describe('buildLocalDaemonServiceSystemTaskSpec', () => {
    it('builds daemon service start tasks for the local machine', () => {
        expect(buildLocalDaemonServiceSystemTaskSpec('daemon.service.start.v1')).toEqual({
            protocolVersion: 1,
            kind: 'daemon.service.start.v1',
            params: {
                target: { kind: 'local' },
                surface: 'desktop.ui',
                mode: 'user',
            },
        });
    });

    it('builds daemon service stop tasks for the local machine', () => {
        expect(buildLocalDaemonServiceSystemTaskSpec('daemon.service.stop.v1')).toEqual({
            protocolVersion: 1,
            kind: 'daemon.service.stop.v1',
            params: {
                target: { kind: 'local' },
                surface: 'desktop.ui',
                mode: 'user',
            },
        });
    });

    it('builds daemon service restart tasks for the local machine', () => {
        expect(buildLocalDaemonServiceSystemTaskSpec('daemon.service.restart.v1')).toEqual({
            protocolVersion: 1,
            kind: 'daemon.service.restart.v1',
            params: {
                target: { kind: 'local' },
                surface: 'desktop.ui',
                mode: 'user',
            },
        });
    });
});

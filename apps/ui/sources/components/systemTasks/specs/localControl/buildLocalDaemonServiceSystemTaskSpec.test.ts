import { describe, expect, it, vi } from 'vitest';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';

describe('buildLocalDaemonServiceSystemTaskSpec', () => {
    it('uses channel=dev for publicdev builds', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({
            config: {
                variant: 'publicdev',
            },
        }));

        const { buildLocalDaemonServiceSystemTaskSpec } = await import('./buildLocalDaemonServiceSystemTaskSpec');
        const spec = buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1');
        const params = spec.params as Record<string, unknown>;
        expect(params.channel).toBe('dev');
    });

    it('builds daemon service start tasks for the local machine', () => {
        expect(buildLocalDaemonServiceSystemTaskSpec('daemon.service.start.v1')).toEqual({
            protocolVersion: 1,
            kind: 'daemon.service.start.v1',
            params: {
                channel: 'stable',
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
                channel: 'stable',
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
                channel: 'stable',
                target: { kind: 'local' },
                surface: 'desktop.ui',
                mode: 'user',
            },
        });
    });
});

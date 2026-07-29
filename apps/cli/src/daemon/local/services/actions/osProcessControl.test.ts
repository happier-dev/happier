import { describe, expect, it, vi } from 'vitest';

import { createOsProcessControl } from './osProcessControl';

describe('createOsProcessControl', () => {
    it('returns the live listener process start time and provenance when the shared scan supplies it', async () => {
        const control = createOsProcessControl({
            platform: 'darwin',
            wait: async () => {},
            scan: vi.fn(async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 4_321 }],
                processes: new Map([
                    [4_321, {
                        pid: 4_321,
                        ppid: 300,
                        command: 'node ./server.js',
                        processStartTimeMs: 1_717_171_717_000,
                        cwd: '/repo/web',
                    }],
                    [300, {
                        pid: 300,
                        command: 'npm run dev',
                        cwd: '/repo',
                    }],
                ]),
            })),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5173 })).resolves.toEqual({
            pid: 4_321,
            startTime: 1_717_171_717_000,
            command: 'npm run dev',
            cwd: '/repo',
        });
    });
});

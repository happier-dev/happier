import { describe, expect, it } from 'vitest';

import type { ExecRuntimeServiceV1 } from './exec.js';

export function assertManagedInstallableSpawnClientAuthoring(exec: ExecRuntimeServiceV1): void {
    void exec.spawnClient({
        launch: {
            kind: 'managed-installable',
            installableId: 'dep.acme.sidecar',
            executableName: 'sidecar',
            args: ['--runtime'],
            cwd: '/workspace',
            env: {
                HAPPIER_PLUGIN_RUNTIME: '1',
            },
            sourcePreference: 'managed-first',
        },
        transport: {
            kind: 'spawned-loopback-websocket',
            handshake: {
                byteOrder: 'little-endian',
                requestFrames: [
                    new Uint8Array([1, 2, 3]),
                ],
                response: {
                    byteOrder: 'little-endian',
                    maxFrameBytes: 1024,
                    timeoutMs: 250,
                },
            },
        },
        protocol: {
            kind: 'json-websocket',
            endpoint: {
                decodeHandshakeResponse: () => ({
                    host: '127.0.0.1',
                    port: 12345,
                }),
            },
        },
    });
}

describe('exec managed-installable launch authoring', () => {
    it('keeps the public spawnClient authoring assertion in the test graph', () => {
        expect(assertManagedInstallableSpawnClientAuthoring).toBeTypeOf('function');
    });
});

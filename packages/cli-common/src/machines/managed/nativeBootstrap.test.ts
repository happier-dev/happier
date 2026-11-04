import type { JsonValue } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedNativeBootstrapIO } from './nativeBootstrap.js';

const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ homeId: 'home', managedId: 'managed', requestId: 'request',
    expectedIntentRevision: 0, controller: { machineId: 'controller', installationId: 'installation' },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-resource' } } });

describe('portable native enrollment IO', () => {
    it('preserves private Unicode input, binary views and decoded native output', async () => {
        const bytes = new Uint8Array([5, 0, 255, 128, 42]);
        const io = createManagedNativeBootstrapIO(correlation, async (role, body): Promise<JsonValue> => {
            if (role === 'putFile') {
                expect(body).toEqual({ resource: correlation.resource.value, guestPath: '/payload', bytesBase64: encodeBase64(bytes.subarray(1, 4)) });
                return { kind: 'confirmed' };
            }
            expect(role).toBe('exec');
            expect(body).toEqual({ resource: correlation.resource.value, argv: ['sh', '-c', 'read-private'],
                inputBase64: encodeBase64(new TextEncoder().encode('秘密\n')) });
            return { stdoutBase64: encodeBase64(new TextEncoder().encode('\uFEFFhéllo')), stderrBase64: '',
                stdoutTruncated: false, stderrTruncated: false,
                termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } };
        });
        await io.putFile({ path: '/payload', bytes: bytes.subarray(1, 4) });
        expect(await io.exec({ command: 'read-private', input: '秘密\n' })).toEqual({ status: 0, stdout: '\uFEFFhéllo', stderr: '' });
        expect(decodeBase64(encodeBase64(bytes.subarray(1, 4)))).toEqual(bytes.subarray(1, 4));
    });
    it('never decodes incomplete native output as command success', async () => {
        const io = createManagedNativeBootstrapIO(correlation, async () => ({ stdoutBase64: 'c2VjcmV0', stderrBase64: '',
            stdoutTruncated: true, stderrTruncated: false,
            termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } }));
        await expect(io.exec({ command: 'private-command' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    });
});

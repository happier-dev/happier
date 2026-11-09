import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { decodeBase64, encodeBase64, encryptWithDataKey, decryptWithDataKey } from '@/api/encryption';

it('keeps the optional qualification key readable by the released daemon-to-UI result reader', async () => {
    const fixture: unknown = JSON.parse(await readFile(new URL('./machineProvisioners.releasedReader.fixture.json', import.meta.url), 'utf8'));
    if (!fixture || typeof fixture !== 'object' || !('encryptionClass' in fixture)
        || typeof fixture.encryptionClass !== 'string' || !('reader' in fixture)
        || typeof fixture.reader !== 'string') throw new Error('Released reader fixture is incomplete');
    // Exact released web/desktop/mobile 0.2.17 and web preview.19 source at b8d1c449c46ab4dfa8637db36b66f643d149e66d.
    // The released machineRPC returns this decoder's result directly, without a provisioner schema.
    expect(fixture.reader).toContain('return await machineEncryption.decryptRaw(result.result) as R;');
    const source = stripTypeScriptTypes(fixture.encryptionClass.replace('export class ', 'class ')
        + '\nMachineEncryption;', { mode: 'strip' });
    // VM evaluation is the genuinely untyped historical-client fixture boundary.
    const Reader = runInNewContext(source, { decodeBase64, encodeBase64,
        // Telemetry is the external observation boundary; the historical decoder and real crypto run unchanged.
        syncPerformanceTelemetry: { measureAsync: async (_event: string, _facts: unknown,
            operation: () => Promise<unknown>) => await operation() },
    }) as new (machineId: string, encryptor: object, cache: object) => {
        decryptRaw(value: string): Promise<unknown>;
    };
    const result = MachineProvisionerCheckResultV1Schema.parse({ available: true,
        nativeCredentialDelivery: { status: 'supported' } });
    const key = new Uint8Array(32).fill(17);
    const crypto = { decrypt: async (values: Uint8Array[]) => values.map(value => decryptWithDataKey(value, key)) };
    await expect(new Reader('worker', crypto, {}).decryptRaw(encodeBase64(encryptWithDataKey(result, key))))
        .resolves.toEqual(result);
    // Tolerance of a new display fact grants no native operation on the released client.
    expect(result.nativeCredentialDelivery?.status).toBe('supported');
});

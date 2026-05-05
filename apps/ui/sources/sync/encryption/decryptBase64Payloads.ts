import { decodeBase64 } from '@/encryption/base64';

import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { type Decryptor, hasBase64Decryptor } from './encryptor';

export type Base64PayloadDecryptTelemetry = Readonly<{
    decryptName: string;
    decryptFields: Record<string, number>;
    decode?: Readonly<{ name: string; fields: Record<string, number> }>;
}>;

function decodeCiphertexts(
    values: readonly string[],
    telemetry?: Readonly<{ name: string; fields: Record<string, number> }>,
): Uint8Array[] {
    if (!telemetry) {
        return values.map((value) => decodeBase64(value, 'base64'));
    }
    return syncPerformanceTelemetry.measure(
        telemetry.name,
        telemetry.fields,
        () => values.map((value) => decodeBase64(value, 'base64')),
    );
}

export async function decryptBase64Payloads(
    decryptor: Decryptor,
    values: readonly string[],
    telemetry: Base64PayloadDecryptTelemetry,
): Promise<(any | null)[]> {
    if (hasBase64Decryptor(decryptor)) {
        return await syncPerformanceTelemetry.measureAsync(
            telemetry.decryptName,
            telemetry.decryptFields,
            async () => decryptor.decryptBase64(values),
        );
    }
    const encrypted = decodeCiphertexts(values, telemetry.decode);
    return await syncPerformanceTelemetry.measureAsync(
        telemetry.decryptName,
        telemetry.decryptFields,
        async () => decryptor.decrypt(encrypted),
    );
}

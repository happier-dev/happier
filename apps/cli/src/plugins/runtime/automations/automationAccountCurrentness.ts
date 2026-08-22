import {
    AccountEncryptionCurrentnessResponseSchema,
    AutomationAccountCurrentnessWitnessV1Schema,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    type AccountEncryptionCurrentnessResponse,
    type AccountScopedCryptoMaterialSnapshotV1,
    type AutomationAccountCurrentnessWitnessV1,
} from '@happier-dev/protocol';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';

type PlainAutomationAccountCurrentnessWitnessV1 =
    AutomationAccountCurrentnessWitnessV1 & Readonly<{
        mode: 'plain';
        contentKeyFingerprint: null;
    }>;

type E2eeAutomationAccountCurrentnessWitnessV1 =
    AutomationAccountCurrentnessWitnessV1 & Readonly<{
        mode: 'e2ee';
        contentKeyFingerprint: string;
    }>;

type AvailablePlainAutomationAccountEncryptionV1 = Readonly<{
    kind: 'available';
    witness: PlainAutomationAccountCurrentnessWitnessV1;
    material?: never;
}>;

export type AvailableE2eeAutomationAccountEncryptionV1 = Readonly<{
    kind: 'available';
    witness: E2eeAutomationAccountCurrentnessWitnessV1;
    material: AccountScopedCryptoMaterialSnapshotV1;
}>;

export type AvailableAutomationAccountEncryptionV1 =
    | AvailablePlainAutomationAccountEncryptionV1
    | AvailableE2eeAutomationAccountEncryptionV1;

export type ValidatedAutomationAccountEncryptionV1 =
    | AvailableAutomationAccountEncryptionV1
    | Readonly<{
        /** Currentness/material may recover after credential refresh or rekey. */
        kind: 'retry';
        witness: AutomationAccountCurrentnessWitnessV1;
    }>
    | Readonly<{
        kind: 'unavailable';
    }>;

export function isAvailableE2eeAutomationAccountEncryptionV1(
    value: AvailableAutomationAccountEncryptionV1,
): value is AvailableE2eeAutomationAccountEncryptionV1 {
    return value.witness.mode === 'e2ee';
}

export function sameAutomationAccountCurrentnessV1(
    left: AutomationAccountCurrentnessWitnessV1,
    right: AutomationAccountCurrentnessWitnessV1,
): boolean {
    return left.mode === right.mode
        && left.version === right.version
        && left.contentKeyFingerprint === right.contentKeyFingerprint;
}

/**
 * Captures the Account-content owner material for one prospective Automation
 * host evidence attempt. The caller must first establish current E2EE mode;
 * this adapter never derives or caches Account mode from local credentials.
 */
export function createAutomationAccountEncryptionMaterialSnapshotV1(
    credentials: StoredCredentials,
): AccountScopedCryptoMaterialSnapshotV1 | null {
    try {
        const encryption = requireAccountEncryptionCredentials(credentials).encryption;
        return createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material: encryption.type === 'legacy'
                ? { type: 'legacy', secret: encryption.secret }
                : { type: 'dataKey', machineKey: encryption.machineKey },
            ...(encryption.type === 'dataKey'
                ? { dataKeyPublicKey: encryption.publicKey }
                : {}),
        });
    } catch {
        return null;
    }
}

/**
 * Reads the canonical server currentness endpoint and admits local E2EE
 * material only when its Account key fingerprint is current. Plain mode is
 * intentionally keyless and never consults local encryption credentials.
 */
export async function resolveValidatedAutomationAccountEncryptionV1(params: Readonly<{
    signal: AbortSignal;
    resolveAccountEncryptionCurrentness: (
        signal?: AbortSignal,
    ) => Promise<AccountEncryptionCurrentnessResponse>;
    resolveAccountEncryptionMaterial: (
        signal?: AbortSignal,
    ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
}>): Promise<ValidatedAutomationAccountEncryptionV1> {
    let rawCurrentness: AccountEncryptionCurrentnessResponse;
    try {
        rawCurrentness = await params.resolveAccountEncryptionCurrentness(params.signal);
    } catch {
        return { kind: 'unavailable' };
    }
    if (params.signal.aborted) return { kind: 'unavailable' };
    const parsedCurrentness = AccountEncryptionCurrentnessResponseSchema.safeParse(rawCurrentness);
    if (!parsedCurrentness.success) return { kind: 'unavailable' };
    const currentness = parsedCurrentness.data;
    const witness = AutomationAccountCurrentnessWitnessV1Schema.safeParse({
        mode: currentness.mode,
        version: currentness.version,
        contentKeyFingerprint: currentness.contentKeyFingerprint,
    });
    if (!witness.success) return { kind: 'unavailable' };

    if (currentness.mode === 'plain') {
        return {
            kind: 'available',
            witness: {
                mode: 'plain',
                version: witness.data.version,
                contentKeyFingerprint: null,
            },
        };
    }

    let snapshot: AccountScopedCryptoMaterialSnapshotV1 | null;
    try {
        snapshot = await params.resolveAccountEncryptionMaterial(params.signal);
    } catch {
        return { kind: 'retry', witness: witness.data };
    }
    if (params.signal.aborted) return { kind: 'unavailable' };
    if (snapshot === null || currentness.contentKeyFingerprint === null) {
        return { kind: 'retry', witness: witness.data };
    }

    let localFingerprint: string;
    try {
        localFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
        );
    } catch {
        return { kind: 'retry', witness: witness.data };
    }
    const e2eeWitness: E2eeAutomationAccountCurrentnessWitnessV1 = {
        mode: 'e2ee',
        version: witness.data.version,
        contentKeyFingerprint: currentness.contentKeyFingerprint,
    };
    return localFingerprint === currentness.contentKeyFingerprint
        ? { kind: 'available', witness: e2eeWitness, material: snapshot }
        : { kind: 'retry', witness: e2eeWitness };
}

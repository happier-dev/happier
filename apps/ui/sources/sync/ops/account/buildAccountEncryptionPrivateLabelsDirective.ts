import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import {
    openPrivateLabelV1,
    sealPrivateLabelV1,
    type PrivateLabelReadV1,
    type PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import type { AccountEncryptionMigratePrivateLabelsDirectiveV1 } from '@happier-dev/protocol/account/encryptionMigrate';

import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { Encryption } from '@/sync/encryption/encryption';
import {
    assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

export type AccountEncryptionMigrationPrivateLabelCandidate =
    | Readonly<{
        entity: 'account_api_token' | 'account_directory_home';
        field: 'label';
        id: string;
        label: PrivateLabelReadV1;
    }>
    | Readonly<{
        entity: 'machine_pool';
        field: 'name' | 'description';
        id: string;
        label: PrivateLabelReadV1;
    }>;

function privateLabelBinding(
    candidate: AccountEncryptionMigrationPrivateLabelCandidate,
) {
    return { entity: candidate.entity, field: candidate.field, id: candidate.id } as const;
}

function migrationItem(
    candidate: AccountEncryptionMigrationPrivateLabelCandidate,
    label: PrivateLabelStoredV1,
): AccountEncryptionMigratePrivateLabelsDirectiveV1['items'][number] {
    if (candidate.entity === 'account_api_token') {
        return {
            entity: 'account_api_token',
            field: 'label',
            id: candidate.id,
            expectedLabel: candidate.label,
            label,
        };
    }
    if (candidate.entity === 'account_directory_home') {
        return {
            entity: 'account_directory_home',
            field: 'label',
            id: candidate.id,
            expectedLabel: candidate.label,
            label,
        };
    }
    return {
        entity: 'machine_pool',
        field: candidate.field,
        id: candidate.id,
        expectedLabel: candidate.label,
        label,
    };
}

function unavailable(): never {
    throw new Error('private_label_migration_unavailable');
}

async function openSourceLabel(
    params: Readonly<{
        candidate: AccountEncryptionMigrationPrivateLabelCandidate;
        fromMode: 'plain' | 'e2ee';
        sourceEncryption: Encryption | null;
        scope: AccountEncryptionMigrationScope;
    }>,
): Promise<string> {
    const binding = privateLabelBinding(params.candidate);
    if (params.candidate.label.content.t === 'plain') {
        const value = openPrivateLabelV1({ binding, label: params.candidate.label,
            readPolicy: { kind: 'account-owned', contentEncryptionMode: params.fromMode } });
        return value === null ? unavailable() : value;
    }
    if (!params.candidate.label.recipientEnvelope) {
        unavailable();
    }
    if (!params.sourceEncryption) unavailable();
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const dataKey = await params.sourceEncryption.decryptEncryptionKey(
        params.candidate.label.recipientEnvelope.encryptedDataKey,
    );
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    if (!dataKey) unavailable();
    try {
        const value = openPrivateLabelV1({ binding, label: params.candidate.label, dataKey,
            readPolicy: { kind: 'account-owned', contentEncryptionMode: params.fromMode } });
        return value === null ? unavailable() : value;
    } finally {
        dataKey.fill(0);
    }
}

/**
 * Converts Account-owned reader projections with the explicit source and
 * target key material captured for one Account-mode transition.
 */
export async function buildAccountEncryptionPrivateLabelsDirective(
    params: Readonly<{
        accountId: string;
        fromMode: 'plain' | 'e2ee';
        toMode: 'plain' | 'e2ee';
        candidates: readonly AccountEncryptionMigrationPrivateLabelCandidate[];
        sourceEncryption: Encryption | null;
        targetEncryption: Encryption | null;
        scope: AccountEncryptionMigrationScope;
    }>,
): Promise<AccountEncryptionMigratePrivateLabelsDirectiveV1 | undefined> {
    if (params.candidates.length === 0) return undefined;
    const items: AccountEncryptionMigratePrivateLabelsDirectiveV1['items'][number][] = [];
    for (const candidate of params.candidates) {
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        const binding = privateLabelBinding(candidate);
        const value = await openSourceLabel({
            candidate,
            fromMode: params.fromMode,
            sourceEncryption: params.sourceEncryption,
            scope: params.scope,
        });
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        if (params.toMode === 'plain') {
            items.push(migrationItem(candidate, sealPrivateLabelV1({ mode: 'plain', binding, value })));
            continue;
        }
        if (!params.targetEncryption) unavailable();
        const dataKey = getRandomBytes(32);
        try {
            const encryptedDataKey = await params.targetEncryption.encryptEncryptionKey(dataKey);
            assertAccountEncryptionMigrationScopeCurrent(params.scope);
            items.push(migrationItem(candidate, sealPrivateLabelV1({
                mode: 'e2ee', binding, value, dataKey,
                recipients: [{
                    accountId: params.accountId,
                    envelope: {
                        encryptedDataKey: encodeBase64(encryptedDataKey, 'base64'),
                        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(
                            params.targetEncryption.contentDataKey,
                        ),
                    },
                }],
                randomBytes: getRandomBytes,
            })));
        } finally {
            dataKey.fill(0);
        }
    }
    return { items };
}

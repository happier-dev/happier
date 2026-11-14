import type {
    AccountEncryptionMigrateManagedMachinePresetsDirectiveV1,
    ManagedMachinePresetAccountEncryptionMigrationInventoryV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import {
    transitionManagedMachinePresetContentEncryptionModeV1,
    type ManagedMachinePresetEnvelopeV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { getRandomBytes } from '@/platform/cryptoRandom';

/** The conversion inventory contains personal recipes and their exact retained acquired snapshots. */
export async function buildAccountEncryptionManagedMachinePresetsDirective(params: Readonly<{
    accountId: string;
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    inventory: ManagedMachinePresetAccountEncryptionMigrationInventoryV1;
    openSourceDataKey: (encryptedDataKey: string) => Promise<Uint8Array | null>;
    targetContentPublicKey: Uint8Array | null;
}>): Promise<AccountEncryptionMigrateManagedMachinePresetsDirectiveV1> {
    const replace = async (
        row: ManagedMachinePresetAccountEncryptionMigrationInventoryV1['presets'][number]
            | ManagedMachinePresetAccountEncryptionMigrationInventoryV1['snapshots'][number],
    ): Promise<Pick<ManagedMachinePresetEnvelopeV1, 'content' | 'recipients'>> => {
        let sourceDataKey: Uint8Array | null = null;
        try {
            if (row.contentEncryptionMode === 'plain' && params.toMode === 'plain') {
                const replacement = transitionManagedMachinePresetContentEncryptionModeV1({
                    presetId: row.presetId, fromMode: 'plain', toMode: 'plain',
                    source: { content: row.content, recipientEnvelope: row.recipientEnvelope },
                });
                if (!replacement) throw new Error('managed_preset_migration_unavailable');
                return { content: replacement.content, recipients: [...replacement.recipients] };
            }
            if (row.contentEncryptionMode === 'plain' && params.toMode === 'e2ee') {
                if (!params.targetContentPublicKey || row.recipientEnvelope !== null) {
                    throw new Error('managed_preset_migration_unavailable');
                }
                const replacement = transitionManagedMachinePresetContentEncryptionModeV1({
                    presetId: row.presetId, fromMode: 'plain', toMode: 'e2ee',
                    source: { content: row.content, recipientEnvelope: null },
                    accountId: params.accountId, targetContentPublicKey: params.targetContentPublicKey,
                    randomBytes: getRandomBytes,
                });
                if (!replacement) throw new Error('managed_preset_migration_unavailable');
                return { content: replacement.content, recipients: [...replacement.recipients] };
            }
            if (row.contentEncryptionMode !== 'e2ee' || params.toMode !== 'plain' || !row.recipientEnvelope) {
                throw new Error('managed_preset_migration_unavailable');
            }
            sourceDataKey = await params.openSourceDataKey(row.recipientEnvelope.encryptedDataKey);
            if (!sourceDataKey) throw new Error('managed_preset_migration_unavailable');
            const replacement = transitionManagedMachinePresetContentEncryptionModeV1({
                presetId: row.presetId, fromMode: 'e2ee', toMode: 'plain',
                source: { content: row.content, recipientEnvelope: row.recipientEnvelope }, sourceDataKey,
            });
            if (!replacement) throw new Error('managed_preset_migration_unavailable');
            return { content: replacement.content, recipients: [...replacement.recipients] };
        } finally {
            sourceDataKey?.fill(0);
        }
    };
    const presets: AccountEncryptionMigrateManagedMachinePresetsDirectiveV1['presets'] = [];
    for (const row of params.inventory.presets) {
        presets.push({ presetId: row.presetId, expectedRevision: row.expectedRevision, replacement: await replace(row) });
    }
    const snapshots: AccountEncryptionMigrateManagedMachinePresetsDirectiveV1['snapshots'] = [];
    for (const row of params.inventory.snapshots) {
        snapshots.push({ managedId: row.managedId, presetId: row.presetId,
            expectedContentEncryptionMode: row.contentEncryptionMode,
            expectedContent: row.content, expectedRecipientEnvelope: row.recipientEnvelope,
            replacement: await replace(row) });
    }
    return { presets, snapshots };
}

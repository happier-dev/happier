import {
    isPlainMachineDataKeyMarker,
    machineStoredContentMatchesAccountMode,
    type MachineContentKeyTransitionInputV1,
    type MachineContentKeyTransitionResultV1,
} from '@happier-dev/protocol';
import { afterTx, inTx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { buildUpdateMachineUpdate, eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { serializeMachineRow } from './machineSerialization';
import { compareAndSwapMachineContentInTx } from './compareAndSwapMachineContentInTx';

type TransitionResult = MachineContentKeyTransitionResultV1<ReturnType<typeof serializeMachineRow>>;

/** Converts both incumbent encrypted fields together, only while their complete key/version basis is current. */
export async function transitionMachineContentKey(accountId: string, input: MachineContentKeyTransitionInputV1): Promise<TransitionResult> {
    return inTx(async (tx): Promise<TransitionResult> => {
        const account = await tx.account.findUnique({
            where: { id: accountId }, select: { publicKey: true, encryptionMode: true },
        });
        if (!account || resolveEffectiveAccountEncryptionModeFromAccountRow(account) !== 'plain') {
            return { kind: 'refused', code: 'forbidden' };
        }
        const machine = await tx.machine.findFirst({ where: { accountId, id: input.machineId } });
        if (!machine || machine.revokedAt || machine.replacedByMachineId) {
            return { kind: 'refused', code: 'machine_unavailable' };
        }
        const published = serializeMachineRow(machine);
        const current = {
            dataEncryptionKey: published.dataEncryptionKey,
            metadataVersion: machine.metadataVersion,
            daemonStateVersion: machine.daemonStateVersion,
        };
        if (current.dataEncryptionKey !== input.expected.dataEncryptionKey
            || current.metadataVersion !== input.expected.metadataVersion
            || current.daemonStateVersion !== input.expected.daemonStateVersion) {
            return { kind: 'conflict', current };
        }
        if (isPlainMachineDataKeyMarker(machine.dataEncryptionKey)
            || !machineStoredContentMatchesAccountMode({
                mode: 'e2ee', metadata: machine.metadata,
                ...(machine.daemonState === null ? {} : { daemonState: machine.daemonState }),
                dataEncryptionKey: machine.dataEncryptionKey,
            })
            || !machineStoredContentMatchesAccountMode({
                mode: 'plain', metadata: input.next.metadata,
                ...(input.next.daemonState === null ? {} : { daemonState: input.next.daemonState }),
                dataEncryptionKey: input.next.dataEncryptionKey,
            })) {
            return { kind: 'refused', code: 'machine_storage_mode_mismatch' };
        }
        const updated = await compareAndSwapMachineContentInTx({
            tx, accountId, machineId: machine.id, expected: input.expected,
            next: { ...input.next, contentPublicKeyFingerprint: null },
        });
        if (!updated) {
            const fresh = await tx.machine.findFirst({ where: { accountId, id: machine.id } });
            if (!fresh || fresh.revokedAt || fresh.replacedByMachineId) return { kind: 'refused', code: 'machine_unavailable' };
            return { kind: 'conflict', current: {
                dataEncryptionKey: serializeMachineRow(fresh).dataEncryptionKey,
                metadataVersion: fresh.metadataVersion,
                daemonStateVersion: fresh.daemonStateVersion,
            } };
        }
        const converted = await tx.machine.findFirstOrThrow({ where: { accountId, id: machine.id } });
        const cursor = await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machine.id });
        const convertedPublished = serializeMachineRow(converted);
        afterTx(tx, () => {
            eventRouter.emitUpdate({
                userId: accountId,
                payload: buildUpdateMachineUpdate(machine.id, cursor, randomKeyNaked(12),
                    { value: converted.metadata, version: converted.metadataVersion },
                    { value: converted.daemonState, version: converted.daemonStateVersion },
                    { dataEncryptionKey: convertedPublished.dataEncryptionKey, contentPublicKeyFingerprint: null }),
                recipientFilter: { type: 'machine-scoped-only', machineId: machine.id },
            });
        });
        return { kind: 'committed', machine: convertedPublished };
    });
}

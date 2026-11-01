import * as privacyKit from 'privacy-kit';
import type { MachineKeyBasisV1 } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';

/** Converts the complete content triple only while its key, both versions and lifecycle remain current. */
export async function compareAndSwapMachineContentInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    expected: MachineKeyBasisV1;
    expectedLifecycle?: Readonly<{
        revokedAt: Date | null;
        replacedByMachineId: string | null;
    }>;
    next: Readonly<{
        dataEncryptionKey: string | null;
        metadata: string;
        daemonState: string | null;
        contentPublicKeyFingerprint?: string | null;
    }>;
}>): Promise<boolean> {
    const updated = await params.tx.machine.updateMany({
        where: {
            accountId: params.accountId,
            id: params.machineId,
            ...(params.expectedLifecycle ?? { revokedAt: null, replacedByMachineId: null }),
            dataEncryptionKey: params.expected.dataEncryptionKey === null
                ? null : privacyKit.decodeBase64(params.expected.dataEncryptionKey),
            metadataVersion: params.expected.metadataVersion,
            daemonStateVersion: params.expected.daemonStateVersion,
        },
        data: {
            dataEncryptionKey: params.next.dataEncryptionKey === null
                ? null : privacyKit.decodeBase64(params.next.dataEncryptionKey),
            metadata: params.next.metadata,
            metadataVersion: { increment: 1 },
            daemonState: params.next.daemonState,
            daemonStateVersion: { increment: 1 },
            ...(params.next.contentPublicKeyFingerprint === undefined ? {} : {
                contentPublicKeyFingerprint: params.next.contentPublicKeyFingerprint,
            }),
        },
    });
    return updated.count === 1;
}

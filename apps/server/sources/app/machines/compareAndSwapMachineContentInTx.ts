import * as privacyKit from "privacy-kit";
import type { MachineKeyBasisV1 } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";
import type { Tx } from "@/storage/inTx";

/** The shared opaque whole-content CAS for Account migration and Machine key conversion. */
export async function compareAndSwapMachineContentInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    expected: MachineKeyBasisV1;
    next: Readonly<{
        metadata: string;
        daemonState: string | null;
        dataEncryptionKey: string | null;
        contentPublicKeyFingerprint?: string | null;
    }>;
    currentness?: Readonly<{
        installationId: string | null;
        revokedAt: Date | null;
        replacedByMachineId: string | null;
    }>;
}>): Promise<boolean> {
    const updated = await params.tx.machine.updateMany({
        where: {
            accountId: params.accountId,
            id: params.machineId,
            metadataVersion: params.expected.metadataVersion,
            daemonStateVersion: params.expected.daemonStateVersion,
            dataEncryptionKey: params.expected.dataEncryptionKey === null
                ? null
                : privacyKit.decodeBase64(params.expected.dataEncryptionKey),
            ...params.currentness,
        },
        data: {
            metadata: params.next.metadata,
            metadataVersion: params.expected.metadataVersion + 1,
            daemonState: params.next.daemonState,
            daemonStateVersion: params.expected.daemonStateVersion + 1,
            dataEncryptionKey: params.next.dataEncryptionKey === null
                ? null
                : privacyKit.decodeBase64(params.next.dataEncryptionKey),
            ...(params.next.contentPublicKeyFingerprint !== undefined
                ? { contentPublicKeyFingerprint: params.next.contentPublicKeyFingerprint }
                : {}),
            updatedAt: new Date(),
        },
    });
    return updated.count === 1;
}

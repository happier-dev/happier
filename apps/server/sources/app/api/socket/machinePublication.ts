import type { Socket } from 'socket.io';
import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { resolveCurrentMachineRecipientAccountIdsInTx, lockMachinePublicationInTx } from '@/app/machines/machineAccess';
import { isPlainMachineDataKeyMarker, decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { isMachinePublishedContentSafeV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readAccountStoredContentCompatibilityForSocket, buildAccountStoredContentSocketUpgradeError } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { readVerifiedMachineSocketInstallationIdFromSocketData } from './machineSocketInstallationProof';
import { buildMachineActivityEphemeral, eventRouter } from '@/app/events/eventRouter';
import { submitMachineRemoteAlerts } from '@/app/activity/remoteAlerts/submitMachineRemoteAlerts';
import type { MachineAliveAdmission } from '@/app/presence/presenceRecorder';
import { db } from '@/storage/db';
import { log } from '@/utils/logging/log';
import * as privacyKit from 'privacy-kit';

export async function acquireMachinePublicationLocksInTx(tx: Tx, machineId: string): Promise<string[]> {
    // SQLite already admits one writer. PostgreSQL/MySQL use the same ordered
    // Account fence as the publication that follows the Machine CAS.
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") {
        return resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId);
    }
    const hintedAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId);
    await acquireAccountChangePublicationLocksInTx(tx, hintedAccountIds, { includeSingleAccount: true });
    // KEY SHARE admits concurrent content publishers. Read the revision and
    // installation only after the Machine row itself excludes another writer.
    await lockMachinePublicationInTx(tx, machineId);
    const lockedAccountIds = new Set(hintedAccountIds);
    const currentAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId);
    if (currentAccountIds.some(accountId => !lockedAccountIds.has(accountId))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    // The stabilized admission supplies this finite publication. New grants
    // and withdrawals are observed by the next request, before its writes.
    return currentAccountIds;
}

export function readMarkedMachineSocketUpgradeRequired(
    socket: Socket,
    dataEncryptionKey: Uint8Array | null | undefined,
) {
    if (!isPlainMachineDataKeyMarker(dataEncryptionKey)) {
        return null;
    }
    const compatibility =
        readAccountStoredContentCompatibilityForSocket(socket);
    return compatibility.supportsCurrentProtocol
        ? null
        : buildAccountStoredContentSocketUpgradeError(compatibility).data;
}

export function readSocketMachineIdentity(socket: Socket): {
    clientType: unknown;
    machineId: string | null;
} {
    const data = socket.data as { clientType?: unknown; machineId?: unknown } | undefined;
    return {
        clientType: data?.clientType,
        machineId: typeof data?.machineId === 'string' && data.machineId
            ? data.machineId
            : null,
    };
}

export function readAuthenticatedMachineId(socket: Socket): string | null {
    const { clientType, machineId } = readSocketMachineIdentity(socket);
    return clientType === 'machine-scoped' ? machineId : null;
}

export function hasCurrentMachineSocketInstallation(socket: Socket, installationId: string | null): boolean {
    if (!readAuthenticatedMachineId(socket)) return true;
    if (installationId === null) return false;
    return readVerifiedMachineSocketInstallationIdFromSocketData(socket.data) === installationId;
}

/**
 * Handlers trust a machine-scoped socket's handshake admission because revoke, replacement and
 * installation change disconnect it by push. That push targets the Machine room, so one read
 * after the room join (and after a possibly lost cluster push) closes the window in which it
 * could miss this socket. Never called per event.
 */
export async function isMachineScopedSocketAdmissionCurrent(socket: Socket, accountId: string): Promise<boolean> {
    const machineId = readAuthenticatedMachineId(socket);
    if (!machineId) return true;
    const machine = await db.machine.findFirst({ where: { accountId, id: machineId },
        select: { revokedAt: true, replacedByMachineId: true, installationId: true } });
    if (!machine || machine.revokedAt || machine.replacedByMachineId) return false;
    const verifiedInstallationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
    return verifiedInstallationId === null || machine.installationId === verifiedInstallationId;
}

/** Cluster backstop: re-check each local machine-scoped socket once and disconnect any that lost admission. */
export async function reconfirmMachineScopedSocketAdmissions(sockets: Iterable<Socket>): Promise<void> {
    for (const socket of [...sockets]) {
        const accountId = (socket.data as { userId?: unknown } | undefined)?.userId;
        if (typeof accountId !== 'string' || !readAuthenticatedMachineId(socket)) continue;
        try {
            if (!await isMachineScopedSocketAdmissionCurrent(socket, accountId)) socket.disconnect(true);
        } catch (error) {
            log({ module: 'websocket', level: 'warn', event: 'machine_socket_reconfirm_failed', error },
                'Machine socket admission re-check after a possibly lost cluster push failed; the socket stays connected');
        }
    }
}

export function encodedMachineEnvelope(dataEncryptionKey: Uint8Array<ArrayBuffer> | null): string | null {
    return dataEncryptionKey === null ? null : privacyKit.encodeBase64(dataEncryptionKey);
}

export function isSafePlainMachinePublication(metadata: string, daemonState: string | null): boolean {
    try {
        return isMachinePublishedContentSafeV1({
            metadata: decodePlainMachineStoredContent(metadata),
            daemonState: daemonState === null ? null : decodePlainMachineStoredContent(daemonState),
        });
    } catch {
        return false;
    }
}

export function resolveMachineScopedPayloadMachineId(socket: Socket, payloadMachineId: unknown): string | null {
    const authenticatedMachineId = readAuthenticatedMachineId(socket);
    if (!authenticatedMachineId) return null;
    if (typeof payloadMachineId === 'string' && payloadMachineId && payloadMachineId !== authenticatedMachineId) {
        return null;
    }
    return authenticatedMachineId;
}

export function resolveMachineMetadataTarget(
    socket: Socket,
    payloadMachineId: string | undefined,
): string | null {
    const { clientType } = readSocketMachineIdentity(socket);
    if (clientType === 'machine-scoped') {
        return resolveMachineScopedPayloadMachineId(socket, payloadMachineId);
    }
    if (clientType === 'user-scoped' || clientType === undefined) {
        return payloadMachineId ?? null;
    }
    return null;
}

export async function publishMachineAliveObservation(userId: string, machineId: string, timestamp: number,
    presence: MachineAliveAdmission, reconnected = false, workSummaryChanged = false): Promise<void> {
    if (presence.wasOffline || reconnected) {
        const payload = { ...buildMachineActivityEphemeral(machineId, true, timestamp),
            ...(reconnected ? { reconnected: true as const } : {}) };
        for (const accountId of presence.recipientAccountIds) eventRouter.emitEphemeral({
            userId: accountId, payload, recipientFilter: { type: 'user-scoped-only' },
        });
        if (presence.wasOffline) await submitMachineRemoteAlerts({ machines: [{ machineId, accountId: userId }], phase: 'recovered' });
    } else {
        await eventRouter.publishLegacyMachineHeartbeat({ machineId, activeAt: timestamp });
    }
    if (workSummaryChanged) {
        const recipientAccountIds = presence.wasOffline ? presence.recipientAccountIds
            : await resolveCurrentMachineRecipientAccountIdsInTx(db, machineId, userId);
        for (const accountId of recipientAccountIds) eventRouter.emitEphemeral({
            userId: accountId, payload: { type: 'machine-work-summary-changed', machineId },
            recipientFilter: { type: 'user-scoped-only' },
        });
    }
}


import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { resolveCurrentSessionRecipientAccountIds } from '@/app/session/access/sessionRecipients';
import { resolveCurrentMachineRecipientAccountIdsInTx } from '@/app/machines/machineAccess';
import { inReadSnapshot } from '@/storage/inTx';

export type LocalServicePublicPreviewChange = Readonly<{
    actorId: string;
    owner: LocalServicePreviewResourceV1['owner'];
    sessionId?: string;
    serviceTarget?: LocalServicePreviewResourceV1['serviceTarget'];
    change: Extract<EphemeralUpdate, { type: 'local-service-public-preview-changed' }>;
}>;

/** Wake current readers; status admission remains the authority for exposure disclosure. */
export async function publishLocalServicePublicPreviewChange(input: LocalServicePublicPreviewChange): Promise<void> {
    const recipients = new Set([input.actorId]);
    if (input.owner.kind === 'user') recipients.add(input.owner.id);
    // Match public-status admission: managed Service authority is Machine-scoped,
    // while every other readable preview uses Session access.
    if (input.serviceTarget) {
        const accountIds = await inReadSnapshot(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, input.change.machineId));
        for (const accountId of accountIds) recipients.add(accountId);
    } else if (input.sessionId) {
        for (const accountId of await resolveCurrentSessionRecipientAccountIds({ sessionId: input.sessionId })) recipients.add(accountId);
    }
    await Promise.all([...recipients].map(userId => eventRouter.emitEphemeral({
        userId,
        recipientFilter: { type: 'user-scoped-only' },
        payload: input.change,
    })));
}

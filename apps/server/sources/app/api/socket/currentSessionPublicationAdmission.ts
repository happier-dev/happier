import type { Socket } from 'socket.io';
import type { ClientConnection } from '@/app/events/eventPayloadTypes';
import { readCurrentSessionPublicationAudienceInTx } from '@/app/session/access/sessionRecipients';
import type { SessionTranscriptPublicationFields } from '@/app/session/sessionTranscriptPublicationPolicy';
import { inReadSnapshot } from '@/storage/inTx';
import { holdSessionPublicationAudience } from './sessionConsumption';
import { isMachineBoundPublisherSocketForSession } from './sessionScopedBinding';

/**
 * Connect admitted this exact Machine-bound publisher and every withdrawal
 * evicts its socket. Who receives its events is the audience owner's census,
 * read once and held until the committed Session access change retires it or
 * the event opens a new segment.
 */
export async function admitCurrentSessionPublication<T>(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    sessionId: string;
    parse: () => T | null;
    opensSegment?: (value: T) => boolean;
}>): Promise<Readonly<{
    value: T;
    recipientAccountIds: readonly string[];
    publication: SessionTranscriptPublicationFields;
}> | null> {
    if (!isMachineBoundPublisherSocketForSession(params)) return null;
    const value = params.parse();
    if (value === null) return null;
    const opensSegment = params.opensSegment?.(value) === true;
    const audience = await holdSessionPublicationAudience(params.socket, params.sessionId, opensSegment, () => (
        inReadSnapshot(tx => readCurrentSessionPublicationAudienceInTx(tx, { sessionId: params.sessionId }))));
    if (audience.recipientAccountIds.length === 0) return null;
    return { value, ...audience };
}

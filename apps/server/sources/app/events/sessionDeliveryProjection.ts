import type { Socket } from 'socket.io';
import { buildSessionMessageObservationFactsV1, classifySessionEventDelivery, type SessionMessageV1 } from '@happier-dev/protocol';

import { appliesDurableMessageAppends, consumesSessionPersonalEvents, readSessionSocketConsumption } from '@/app/api/socket/sessionConsumption';
import { readAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { projectSessionTurnWaitingCompatibility } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { log } from '@/utils/logging/log';
import type { SocketRoomEventName } from './socketRoomEmitter';

// Each entry lives only as long as its delivery payload, so sockets that receive the same
// projection share one object and Socket.IO encodes it once.
const hintProjectionByDelivery = new WeakMap<object, unknown>();
const omittedMetadataProjectionByDelivery = new WeakMap<object, unknown>();

function projectOncePerDelivery(
    projections: WeakMap<object, unknown>,
    delivery: object,
    project: () => unknown,
): unknown {
    if (projections.has(delivery)) return projections.get(delivery);
    const projection = project();
    projections.set(delivery, projection);
    return projection;
}

function projectPayloadForSocket(data: Socket['data'], payload: unknown): unknown {
    payload = projectSessionTurnWaitingCompatibility(payload, readAccountStoredContentCompatibilityForSocket({ data }));
    if (data.authTokenKind !== 'api_token' || !payload || typeof payload !== 'object') return payload;
    const container = payload as Readonly<Record<string, unknown>>;
    const body = container.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return payload;
    const update = body as Readonly<Record<string, unknown>>;
    if (update.t !== 'update-session' || !('access' in update)) return payload;
    const { access: _access, ...viewerBody } = update;
    return { ...container, body: viewerBody };
}

/** Live transcript segments: delivered to UI consumers only through admitted live demand. */
export function isLiveTranscriptSegmentDelivery(eventName: SocketRoomEventName, payload: unknown): boolean {
    if (eventName !== 'ephemeral' || !payload || typeof payload !== 'object') return false;
    const type = (payload as Readonly<Record<string, unknown>>).type;
    return type === 'transcript-stream-segment' || type === 'transcript-stream-segment-delta';
}

/** Publisher-streamed events, decided per socket once rather than per event. */
export function classifyLiveSessionDelivery(eventName: SocketRoomEventName, payload: unknown): "segment" | "execution-run" | null {
    if (isLiveTranscriptSegmentDelivery(eventName, payload)) return "segment";
    return eventName === 'ephemeral' && !!payload && typeof payload === 'object'
        && (payload as Readonly<Record<string, unknown>>).type === 'execution-run-updated' ? "execution-run" : null;
}

function isMessageUpdateAppend(value: unknown): value is Readonly<{ content: unknown; base: Readonly<{ updatedAt: number; length: number }> }> {
    if (!value || typeof value !== 'object') return false;
    const { content, base } = value as Readonly<Record<string, unknown>>;
    if (!content || typeof content !== 'object' || !base || typeof base !== 'object') return false;
    const { updatedAt, length } = base as Readonly<Record<string, unknown>>;
    return Number.isSafeInteger(updatedAt) && Number.isSafeInteger(length) && (length as number) >= 0;
}

/**
 * Whether this socket reads this Session delivery at all. Decided before the per-socket
 * access decision, so a socket with no reader costs neither an admission nor an emit.
 */
export function socketConsumesSessionDelivery(data: Socket['data'], eventName: SocketRoomEventName, payload: unknown): boolean {
    if (eventName !== 'ephemeral' || !payload || typeof payload !== 'object') return true;
    return (payload as Readonly<Record<string, unknown>>).type !== 'session-personal-event' || consumesSessionPersonalEvents(data);
}

/** Project content demand using the same current Session snapshot as delivery admission. */
export function projectSessionDeliveryForSocket(
    data: Socket['data'],
    sessionId: string,
    eventName: SocketRoomEventName,
    payload: unknown,
    isSessionOwner: boolean,
    metadataLayoutVersion: number,
): unknown | null {
    if (!payload || typeof payload !== 'object') return projectPayloadForSocket(data, payload);
    const record = payload as Readonly<Record<string, unknown>>;
    if (isLiveTranscriptSegmentDelivery(eventName, payload)) {
        const event = record.type === 'transcript-stream-segment' ? 'checkpoint' : 'delta';
        return classifySessionEventDelivery({ event, consumption: readSessionSocketConsumption(data, sessionId) }).delivery === 'skip' ? null : payload;
    }
    if (eventName === 'update' && record.body && typeof record.body === 'object') {
        const body = record.body as Readonly<Record<string, unknown>>;
        if (body.t === 'update-session'
            // Recipients still consume completion and Action facts from shared metadata.
            && isSessionOwner
            && classifySessionEventDelivery({ event: body.t, consumption: readSessionSocketConsumption(data, sessionId) }).delivery === 'hint'
            && body.metadata && typeof body.metadata === 'object' && 'version' in body.metadata) {
            const { metadata, ownerMetadata: _ownerMetadata, ...projection } = body;
            return projectPayloadForSocket(data, projectOncePerDelivery(omittedMetadataProjectionByDelivery, record, () => ({ ...record, body: {
                ...projection, metadataDocument: 'omitted', metadataVersion: metadata.version,
                metadataLayoutVersion: body.metadataLayoutVersion ?? metadataLayoutVersion,
            } })));
        }
        if (body.t === 'new-message' || body.t === 'message-updated') {
            if (body.delivery !== 'full' && body.delivery !== 'hint') {
                log({ module: 'websocket', level: 'warn', sessionId }, 'Session message delivery discriminant unavailable');
                return null;
            }
            const decision = classifySessionEventDelivery({ event: body.t, consumption: readSessionSocketConsumption(data, sessionId) });
            const { append, ...fullBody } = body;
            if (decision.delivery === 'hint' && body.delivery === 'full') {
                // Protected forwarding carries the canonical producer's already-serialized full row.
                return projectOncePerDelivery(hintProjectionByDelivery, record, () => (
                    { ...record, body: { ...fullBody, delivery: 'hint', message: buildSessionMessageObservationFactsV1(body.message as SessionMessageV1) } }
                ));
            }
            if (append !== undefined) {
                // A revision's producer append: only what changed reaches a consumer that applies
                // it against the named base; every other full-body consumer keeps the full row.
                if (appliesDurableMessageAppends(data) && isMessageUpdateAppend(append)) {
                    const { base, content } = append;
                    return projectPayloadForSocket(data, { ...record, body: {
                        ...fullBody, delivery: 'delta', message: { ...(body.message as Record<string, unknown>), content }, base,
                    } });
                }
                return projectPayloadForSocket(data, { ...record, body: fullBody });
            }
        }
    }
    return projectPayloadForSocket(data, payload);
}

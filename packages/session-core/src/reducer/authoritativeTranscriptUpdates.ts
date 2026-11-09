import type { AgentEvent, NormalizedMessage } from '../raw/index.js';
import type { ReducerMessage, ReducerState } from './reducer.js';
import { applyTranscriptObservationMetadata, isRecoveredHistoryTranscriptObservation, type TranscriptObservationMetadata } from '../messages/transcriptObservationProvenance.js';
import { readTranscriptIndex } from './helpers/transcriptIndex.js';

function areMessageActionReferencesEqual(
    left: TranscriptObservationMetadata['messageActionReference'],
    right: TranscriptObservationMetadata['messageActionReference'],
): boolean {
    return left === right || (
        left !== undefined
        && right !== undefined
        && left.v === right.v
        && left.sessionId === right.sessionId
        && left.messageId === right.messageId
        && left.observedRevision === right.observedRevision
    );
}

export function areTranscriptSemanticValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || left === undefined || right === undefined) return false;
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => areTranscriptSemanticValuesEqual(value, right[index]));
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
            && areTranscriptSemanticValuesEqual(leftRecord[key], rightRecord[key]),
    );
}

export function readTranscriptObservationMetadata(message: TranscriptObservationMetadata): TranscriptObservationMetadata {
    return {
        ...(message.sourceCreatedAt !== undefined ? { sourceCreatedAt: message.sourceCreatedAt } : {}),
        ...(message.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: message.sourceUpdatedAt } : {}),
        ...(message.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: message.transcriptObservationProvenance }
            : {}),
        ...(message.deliveryResolution !== undefined ? { deliveryResolution: message.deliveryResolution } : {}),
        ...(message.followDeliveryProjection !== undefined ? { followDeliveryProjection: message.followDeliveryProjection } : {}),
        ...(message.messageActionReference !== undefined ? { messageActionReference: message.messageActionReference } : {}),
    };
}

export function areTranscriptObservationMetadataEqual(
    left: TranscriptObservationMetadata,
    right: TranscriptObservationMetadata,
): boolean {
    return left.sourceCreatedAt === right.sourceCreatedAt
        && left.sourceUpdatedAt === right.sourceUpdatedAt
        && areTranscriptSemanticValuesEqual(
            left.transcriptObservationProvenance,
            right.transcriptObservationProvenance,
        )
        && areTranscriptSemanticValuesEqual(left.deliveryResolution, right.deliveryResolution)
        && areTranscriptSemanticValuesEqual(left.followDeliveryProjection, right.followDeliveryProjection)
        && areMessageActionReferencesEqual(left.messageActionReference, right.messageActionReference);
}

export type AuthoritativeTranscriptTarget = Readonly<{
    kind: 'text';
    messageId: string;
    message: ReducerMessage;
    text: string;
}> | Readonly<{ kind: 'event'; messageId: string; message: ReducerMessage; event: AgentEvent }>;

export function readAuthoritativeTranscriptTarget(
    state: ReducerState,
    source: NormalizedMessage,
): AuthoritativeTranscriptTarget | null {
    if (source.isAuthoritativeUpdate !== true || isRecoveredHistoryTranscriptObservation(source)) {
        return null;
    }

    if (source.role === 'user') {
        const messageId = state.messageIds.get(source.id);
        if (!messageId) return null;
        const message = state.messages.get(messageId);
        if (!message || message.role !== 'user' || message.realID !== source.id) return null;
        return { kind: 'text', messageId, message, text: source.content.text };
    }

    if (source.role === 'event') {
        for (const message of readTranscriptIndex(state).byId.get(source.id) ?? []) {
            if (message.role === 'agent' && message.realID === source.id && message.event !== null
                && message.tool === null && message.text === null) {
                return { kind: 'event', messageId: message.id, message, event: source.content };
            }
        }
        return null;
    }

    if (source.role !== 'agent' || source.content.length !== 1 || source.content[0]?.type !== 'text') {
        return null;
    }

    const isExactAgentTextTarget = (message: ReducerMessage | undefined): message is ReducerMessage => (
        message?.role === 'agent'
        && message.realID === source.id
        && message.text !== null
        && message.isThinking !== true
        && message.tool === null
        && message.event === null
        && message.transcriptBlockIndex === 0
    );
    const directMessageId = state.messageIds.get(source.id);
    const directMessage = directMessageId ? state.messages.get(directMessageId) : undefined;
    if (directMessageId && isExactAgentTextTarget(directMessage)) {
        return { kind: 'text', messageId: directMessageId, message: directMessage, text: source.content[0].text };
    }
    for (const message of readTranscriptIndex(state).byId.get(source.id) ?? []) {
        if (isExactAgentTextTarget(message)) {
            return { kind: 'text', messageId: message.id, message, text: source.content[0].text };
        }
    }
    return null;
}

export function applyAuthoritativeTranscriptUpdate(
    target: AuthoritativeTranscriptTarget,
    source: NormalizedMessage,
): boolean {
    const { message } = target;
    const didContentChange = target.kind === 'event'
        ? !areTranscriptSemanticValuesEqual(message.event, target.event)
        : message.text !== target.text;
    const didMetaChange = !areTranscriptSemanticValuesEqual(message.meta, source.meta);
    const didStructuredPresentationChange = !areTranscriptSemanticValuesEqual(
        message.structuredPresentation,
        source.structuredPresentation,
    );
    const observationBefore = readTranscriptObservationMetadata(message);
    applyTranscriptObservationMetadata(message, source);
    const didObservationChange = !areTranscriptObservationMetadataEqual(
        observationBefore,
        readTranscriptObservationMetadata(message),
    );
    if (!didContentChange && !didMetaChange && !didStructuredPresentationChange && !didObservationChange) {
        return false;
    }

    // A server-declared update retains the durable row's id, local id, sequence,
    // and creation time; only its renderable semantic fields can be replaced.
    if (target.kind === 'event') message.event = target.event;
    else message.text = target.text;
    message.meta = source.meta;
    if (source.structuredPresentation !== undefined) {
        message.structuredPresentation = source.structuredPresentation;
    } else {
        delete message.structuredPresentation;
    }
    return true;
}

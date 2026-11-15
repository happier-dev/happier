import type { Message } from '../messages/messageTypes.js';
import type { TranscriptObservationMetadata } from '../messages/transcriptObservationProvenance.js';
import type { ReducerMessage, ReducerState } from './reducer.js';

// Published snapshots follow the reducer lifetime. Never skip conversion: mutable rows and
// ancestor-dependent cycle suppression must be observed before retaining an equal value.
const publishedByState = new WeakMap<ReducerState, WeakMap<ReducerMessage, Message>>();

function retainFields<T extends object>(previous: T | undefined, next: T): T {
    if (!previous) return next;
    const keys = Object.keys(next);
    return Object.keys(previous).length === keys.length
        && keys.every(key => Object.hasOwn(previous, key) && Object.is(Reflect.get(previous, key), Reflect.get(next, key)))
        ? previous : next;
}

export function convertReducerMessageToMessage(
    row: ReducerMessage,
    state: ReducerState,
    ancestors?: ReadonlySet<string>,
): Message | null {
    const next = projectReducerMessage(row, state, ancestors);
    if (!next) return null;
    let published = publishedByState.get(state);
    if (!published) {
        published = new WeakMap();
        publishedByState.set(state, published);
    }
    const previous = published.get(row);
    if (next.kind === 'tool-call' && previous?.kind === 'tool-call') {
        if (next.children.length === previous.children.length && next.children.every((child, index) => child === previous.children[index])) {
            next.children = previous.children;
        }
        if (next.tool.permission) next.tool.permission = retainFields(previous.tool.permission, next.tool.permission);
        next.tool = retainFields(previous.tool, next.tool);
    }
    const retained = retainFields(previous, next);
    published.set(row, retained);
    return retained;
}

function projectReducerMessage(
    reducerMsg: ReducerMessage,
    state: ReducerState,
    ancestorMessageIds?: ReadonlySet<string>,
): Message | null {
    const observationMetadata: TranscriptObservationMetadata = {
        ...(reducerMsg.sourceCreatedAt !== undefined ? { sourceCreatedAt: reducerMsg.sourceCreatedAt } : {}),
        ...(reducerMsg.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: reducerMsg.sourceUpdatedAt } : {}),
        ...(reducerMsg.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: reducerMsg.transcriptObservationProvenance }
            : {}),
        ...(reducerMsg.deliveryResolution !== undefined
            ? { deliveryResolution: reducerMsg.deliveryResolution }
            : {}),
        ...(reducerMsg.followDeliveryProjection !== undefined
            ? { followDeliveryProjection: reducerMsg.followDeliveryProjection }
            : {}),
            ...(reducerMsg.messageActionReference !== undefined
            ? { messageActionReference: reducerMsg.messageActionReference }
            : {}),
    };
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        const displayText = typeof reducerMsg.meta?.displayText === 'string' ? reducerMsg.meta.displayText : undefined;
        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            text: reducerMsg.text,
            ...(displayText !== undefined ? { displayText } : {}),
            meta: reducerMsg.meta,
            ...(reducerMsg.structuredPresentation !== undefined
                ? { structuredPresentation: reducerMsg.structuredPresentation }
                : {}),
            ...observationMetadata,
            ...(reducerMsg.accountActor !== undefined ? { accountActor: reducerMsg.accountActor } : {}),
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            ...(reducerMsg.peer && { peer: reducerMsg.peer }),
            meta: reducerMsg.meta,
            ...(reducerMsg.structuredPresentation !== undefined
                ? { structuredPresentation: reducerMsg.structuredPresentation }
                : {}),
            ...observationMetadata,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        if (ancestorMessageIds?.has(reducerMsg.id)) return null;

        // Convert children recursively
        let childMessages: Message[] = [];
        const toolId = typeof reducerMsg.tool.id === 'string' ? reducerMsg.tool.id.trim() : '';
        const sidechainKey =
            toolId.length > 0
                ? (!state.sidechains.has(toolId) && reducerMsg.realID ? reducerMsg.realID : toolId)
                : reducerMsg.realID ?? null;
        let children = sidechainKey ? state.sidechains.get(sidechainKey) || [] : [];
        if (children.length > 0) {
            const childAncestorMessageIds = new Set(ancestorMessageIds);
            childAncestorMessageIds.add(reducerMsg.id);
            for (let child of children) {
                let childMessage = convertReducerMessageToMessage(child, state, childAncestorMessageIds);
                if (childMessage) {
                    childMessages.push(childMessage);
                }
            }
        }

        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool: { ...reducerMsg.tool, ...(reducerMsg.tool.permission ? { permission: { ...reducerMsg.tool.permission } } : {}) },
            children: childMessages,
            meta: reducerMsg.meta,
            ...observationMetadata,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta,
            ...observationMetadata,
        };
    }

    return null;
}

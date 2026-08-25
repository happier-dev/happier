import React from 'react';

import type { MessageStructuredPresentationV1 } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginUiBoundary } from '@/components/plugins/reactNative/PluginUiBoundary';
import { openPluginContributedActionReference } from '@/components/plugins/actions/openPluginContributedAction';
import {
    createPluginPersistedStructuredMessageActionController,
    usePluginMessageActionHost,
} from '@/components/sessions/transcript/messageActions/PluginMessageActions';
import { readUnsupportedContentMeta } from '@/sync/domains/messages/unsupportedContentMeta';
import { resolveUnsupportedContentPresentation } from '@/sync/domains/messages/unsupportedContentPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    deriveTranscriptInteraction,
    type TranscriptInteraction,
} from '@/utils/sessions/deriveTranscriptInteraction';

import {
    DeclarativeStructuredMessageRenderer,
    type StructuredMessageActionSelection,
} from './DeclarativeStructuredMessageRenderer';
import { parseHappierMetaEnvelope } from './happierMetaEnvelope';
import type { StructuredMessageRendererParams } from './structuredMessageRegistry';
import {
    findBuiltInStructuredMessageEntry,
} from './descriptorRegistry';

const NON_STRUCTURED_HAPPIER_META_KINDS = new Set([
    'attachments.v1',
    'session_media.v1',
]);
const FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION = deriveTranscriptInteraction({ kind: 'public' });

type MessageWithStructuredPresentation = (
    | Extract<Message, { kind: 'user-text' }>
    | Extract<Message, { kind: 'agent-text' }>
) & Readonly<{
    structuredPresentation: MessageStructuredPresentationV1;
}>;

function hasStructuredPresentation(
    message: Message,
): message is MessageWithStructuredPresentation {
    return (message.kind === 'user-text' || message.kind === 'agent-text')
        && message.structuredPresentation !== undefined;
}

function isUnavailableStructuredTranscriptRecord(
    message: Message,
    debugInformationEnabled: boolean,
): boolean {
    const kind = readUnsupportedContentMeta(message.meta);
    return kind === 'unsupported-transcript-record'
        && resolveUnsupportedContentPresentation({ kind, debugInformationEnabled }) === 'label';
}

function PersistedPluginStructuredMessage(props: Readonly<{
    message: MessageWithStructuredPresentation;
    interaction: TranscriptInteraction;
}>): React.ReactElement {
    const structuredPresentation = props.message.structuredPresentation!;
    const messageActionHost = usePluginMessageActionHost();
    const [actionPending, setActionPending] = React.useState(false);
    const actionPendingRef = React.useRef(false);
    const controller = React.useMemo(() => (
        createPluginPersistedStructuredMessageActionController({
            host: messageActionHost,
            messageActionReference: props.message.messageActionReference,
        })
    ), [messageActionHost, props.message.messageActionReference]);
    const canDispatchActions = props.interaction.canSendMessages === true && controller !== null;
    const isActionAvailable = React.useCallback((action: StructuredMessageActionSelection) => (
        canDispatchActions && controller!.isReferenceAvailable(action.identity)
    ), [canDispatchActions, controller]);
    const handleAction = React.useCallback((action: StructuredMessageActionSelection) => {
        if (
            !canDispatchActions
            || actionPendingRef.current
            || !controller!.isReferenceAvailable(action.identity)
        ) {
            return;
        }
        actionPendingRef.current = true;
        setActionPending(true);
        fireAndForget(openPluginContributedActionReference({
            controller: controller!,
            action: action.identity,
            // An immutable snapshot carries the input deliberately. Omitted
            // input follows the existing Action default; explicit null remains
            // an admitted author value through the canonical dispatcher.
            ...(action.input === undefined ? {} : { input: action.input }),
            ...(messageActionHost?.signal ? { signal: messageActionHost.signal } : {}),
        }).finally(() => {
            actionPendingRef.current = false;
            setActionPending(false);
        }), { tag: 'PersistedPluginStructuredMessage.openAction' });
    }, [canDispatchActions, controller, messageActionHost?.signal]);
    return (
        <PluginUiBoundary
            surfaceId={`persisted-structured-message:${structuredPresentation.owner.pluginId}/${structuredPresentation.owner.contributionLocalId}`}
            resetKey={props.message.id}
            fallback={<PluginSurfaceFallback testID="structured-message-unavailable" />}
        >
            <DeclarativeStructuredMessageRenderer
                root={structuredPresentation.snapshot}
                onAction={canDispatchActions ? handleAction : undefined}
                isActionAvailable={isActionAvailable}
                actionPending={actionPending}
                showUnavailableActions
            />
        </PluginUiBoundary>
    );
}

export function renderStructuredMessage(params: {
    message: Message;
    sessionId: string;
    interaction: TranscriptInteraction;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    debugInformationEnabled?: boolean;
}): React.ReactElement | null {
    if (hasStructuredPresentation(params.message)) {
        return (
            <PersistedPluginStructuredMessage
                message={params.message}
                interaction={params.interaction}
            />
        );
    }
    // A normalized unavailable historical record may still carry a legacy
    // `happier` envelope from an older writer. Its marked fallback is a
    // terminal reader result, not permission to resolve present plugin code.
    if (isUnavailableStructuredTranscriptRecord(params.message, params.debugInformationEnabled ?? false)) {
        return <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }
    const envelope = parseHappierMetaEnvelope(params.message.meta);
    if (!envelope) return null;
    if (NON_STRUCTURED_HAPPIER_META_KINDS.has(envelope.kind)) return null;

    const builtIn = findBuiltInStructuredMessageEntry(envelope.kind);
    if (builtIn) {
        const parsed = builtIn.schema.safeParse(envelope.payload);
        return parsed.success
            ? builtIn.render(parsed.data, {
                sessionId: params.sessionId,
                message: params.message,
                interaction: params.interaction,
                onJumpToAnchor: params.onJumpToAnchor,
            })
            : <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }

    // Generic plugin envelopes are only renderable after the current CLI
    // admission path has turned them into an immutable `structuredPresentation`.
    // A replay must never resolve present daemon/plugin state to reinterpret an
    // unpersisted payload from history.
    return <PluginSurfaceFallback testID="structured-message-unavailable" />;
}

export const StructuredMessageBlock = React.memo(function StructuredMessageBlock(props: {
    message: Message;
    sessionId: string;
    interaction?: TranscriptInteraction;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    debugInformationEnabled?: boolean;
}): React.ReactElement | null {
    return renderStructuredMessage({
        ...props,
        interaction: props.interaction ?? FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION,
    });
});

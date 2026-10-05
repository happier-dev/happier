import React from 'react';

import type { MessageStructuredPresentationV1 } from '@happier-dev/protocol';

import type { Message } from "@happier-dev/session-core/messages";
import { PluginSurfaceFallback, projectPluginSurfaceFallbackFindText } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginUiBoundary } from '@/components/plugins/reactNative/PluginUiBoundary';
import { openPluginContributedActionReference } from '@/components/plugins/actions/openPluginContributedAction';
import {
    createPluginPersistedStructuredMessageActionController,
    usePluginMessageActionHost,
} from '@/components/sessions/transcript/messageActions/PluginMessageActions';
import { readUnsupportedContentMeta } from "@happier-dev/session-core/messages";
import { resolveUnsupportedContentPresentation } from "@happier-dev/session-core/messages";
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
import { StructuredFindMessageProvider, useStructuredFindState, type StructuredFindTextContext, type StructuredFindTextBlock } from './structuredFindText';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { projectDeclarativeStructuredFindText } from '@/components/plugins/shared/declarativeNodes';

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

/** One admission/selection owner for both the rendered card and pre-mount Find. */
function resolveStructuredMessagePresentation(message: Message, debugInformationEnabled = false) {
    if (hasStructuredPresentation(message)) return { kind: 'persisted' as const, message };
    if (isUnavailableStructuredTranscriptRecord(message, debugInformationEnabled)) return { kind: 'unavailable' as const };
    const envelope = parseHappierMetaEnvelope(message.meta);
    if (!envelope || NON_STRUCTURED_HAPPIER_META_KINDS.has(envelope.kind)) return null;
    const entry = findBuiltInStructuredMessageEntry(envelope.kind);
    if (!entry) return { kind: 'unavailable' as const };
    const parsed = entry.schema.safeParse(envelope.payload);
    return parsed.success ? { kind: 'builtin' as const, entry, payload: parsed.data } : { kind: 'unavailable' as const };
}

function StructuredUnavailableMessage() {
    const find = useStructuredFindState();
    return <PluginSurfaceFallback testID="structured-message-unavailable" renderText={(field, text) => {
        const ranges = find.ranges(`structured-unavailable-${field}`);
        return ranges?.length ? <FindHighlightedText text={text} ranges={ranges} /> : text;
    }} />;
}

/** null follows the incumbent ordinary-Markdown fallback; [] is a replacing card with no text. */
export function projectStructuredMessageFindText(message: Message, context: StructuredFindTextContext = {}): readonly StructuredFindTextBlock[] | null {
    const presentation = resolveStructuredMessagePresentation(message, context.debugInformationEnabled);
    if (!presentation) return null;
    if (presentation.kind === 'persisted') return projectDeclarativeStructuredFindText(presentation.message.structuredPresentation.snapshot);
    if (presentation.kind === 'unavailable') return projectPluginSurfaceFallbackFindText();
    return presentation.entry.projectFindText(presentation.payload, { ...context, message });
}

/** Full-mode review cards use only these validated descriptor-owned comment targets. */
export function collectStructuredMessageReviewRunIds(messages: readonly Message[], context: Pick<StructuredFindTextContext, 'canNavigate' | 'debugInformationEnabled'> = {}): readonly string[] {
    if (context.canNavigate !== false) return [];
    const runIds = new Set<string>();
    for (const message of messages) {
        const presentation = resolveStructuredMessagePresentation(message, context.debugInformationEnabled);
        if (presentation?.kind !== 'builtin') continue;
        for (const runId of presentation.entry.reviewRunIds?.(presentation.payload) ?? []) runIds.add(runId);
    }
    return [...runIds];
}

/** Only review-findings descriptors derive displayed rows from later transcript follow-ups. */
export function structuredMessageFindUsesSessionMessages(message: Message, debugInformationEnabled = false): boolean {
    const presentation = resolveStructuredMessagePresentation(message, debugInformationEnabled);
    return presentation?.kind === 'builtin' && presentation.entry.usesSessionMessages === true;
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
            fallback={<StructuredUnavailableMessage />}
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
    serverId?: string | null;
    interaction: TranscriptInteraction;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    debugInformationEnabled?: boolean;
}): React.ReactElement | null {
    const presentation = resolveStructuredMessagePresentation(params.message, params.debugInformationEnabled);
    if (!presentation) return null;
    const rendered = presentation.kind === 'persisted'
        ? <PersistedPluginStructuredMessage message={presentation.message} interaction={params.interaction} />
        : presentation.kind === 'unavailable'
            ? <StructuredUnavailableMessage />
            : presentation.entry.render(presentation.payload, params);
    return rendered ? <StructuredFindMessageProvider messageId={params.message.id}>{rendered}</StructuredFindMessageProvider> : null;
}

export const StructuredMessageBlock = React.memo(function StructuredMessageBlock(props: {
    message: Message;
    sessionId: string;
    serverId?: string | null;
    interaction?: TranscriptInteraction;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    debugInformationEnabled?: boolean;
}): React.ReactElement | null {
    return renderStructuredMessage({
        ...props,
        interaction: props.interaction ?? FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION,
    });
});

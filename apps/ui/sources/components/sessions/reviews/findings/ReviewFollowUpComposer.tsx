import { t } from '@/text';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { AgentInput } from '@/components/sessions/agentInput';
import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import { useRepositoryComposerDocumentOwner } from '@/components/sessions/composer/useRepositoryComposerDocumentOwner';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { randomUUID } from '@/platform/randomUUID';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Who a follow-up goes to: the reviewers' marks and the words for them ("Sonnet 5", "Both"). */
export type ReviewFollowUpRecipient = Readonly<{
    label: string;
    accessibilityLabel: string;
    backendIds: readonly string[];
}>;

// A follow-up points at code: files can be referenced. Its wire is the question's markdown, so
// nothing that needs a structured part (skills, plugin references, uploads) is offered.
const REVIEW_FOLLOW_UP_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = ['file'];
const RECIPIENT_CHIP_KEY = 'review-follow-up-recipient';

function createRecipientChip(recipient: ReviewFollowUpRecipient, testID: string, renderMark: (backendId: string) => React.ReactNode): AgentInputExtraActionChip {
    return {
        key: RECIPIENT_CHIP_KEY,
        controlId: 'recipient',
        placement: { id: 'recipient', title: t('session.participants.sendToTitle'), defaultPlacement: 'overflow', pending: true },
        stabilityKey: `${recipient.label}:${recipient.backendIds.join(',')}`,
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <View
                ref={ctx.chipAnchorRef}
                testID={testID}
                accessible
                accessibilityLabel={recipient.accessibilityLabel}
                style={[ctx.chipStyle(false), { flexDirection: 'row', alignItems: 'center', gap: 6 }]}
            >
                {recipient.backendIds.map((backendId) => (
                    <React.Fragment key={backendId}>{normalizeNodeForView(renderMark(backendId))}</React.Fragment>
                ))}
                <Text numberOfLines={1} style={ctx.textStyle}>{recipient.label}</Text>
            </View>
        ),
    };
}

/**
 * A review's follow-up composer: the one composer (`AgentInput`) with the follow-up adapter behind
 * it (INT §6 I4 "Ask about this"). The adapter owns what is particular here — the reviewer chip
 * naming who answers, and sending the question as `review.follow_up` through `onSend` — and offers
 * nothing an agent conversation carries: no engine, chips or prompt history.
 *
 * `draftRunId` keeps the question in the synchronized draft repository under that review run.
 * The result mounts one question composer at a time, either the dock or the finding's thread.
 * `onSend` resolves `true` once the question was accepted; only then is the sent text cleared.
 */
export function ReviewFollowUpComposer(props: Readonly<{
    testID: string;
    sessionId: string;
    serverId?: string | null;
    draftRunId: string | null;
    placeholder: string;
    recipient: ReviewFollowUpRecipient;
    onSend: (messageMarkdown: string) => Promise<boolean>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { sessionId } = props;
    const serverId = usePreferredServerIdForSession({ serverId: props.serverId ?? null, sessionId });
    const serverIds = React.useMemo(() => [serverId], [serverId]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const [instanceId] = React.useState(randomUUID);
    const ref = React.useMemo(() => ({ kind: 'participantMessage' as const, sessionId, instanceId }), [instanceId, sessionId]);
    const address = React.useMemo(
        () => (props.draftRunId ? { kind: 'run' as const, sessionId, runId: props.draftRunId } : null),
        [props.draftRunId, sessionId],
    );
    const owner = useRepositoryComposerDocumentOwner({
        scope: address ? binding?.scope ?? null : null,
        ref,
        address,
        capabilities: { text: true, references: true, attachments: false, submit: true },
        isCurrent: () => binding === null || binding.isCurrent(),
    });
    const document = owner.read().document;
    const [sending, setSending] = React.useState(false);
    const sendingRef = React.useRef(false);

    const onChangeText = React.useCallback((text: string) => {
        owner.replaceDocument({ ...owner.read().document, text });
    }, [owner]);
    const onMentionsChange = React.useCallback((structuredInputMentions: Parameters<NonNullable<React.ComponentProps<typeof AgentInput>['onStructuredInputMentionsChange']>>[0]) => {
        owner.replaceDocument({ ...owner.read().document, structuredInputMentions });
    }, [owner]);

    const onSendProp = props.onSend;
    const send = React.useCallback((options?: AgentInputSendOptions) => {
        const text = (options?.inputTextOverride ?? owner.read().document.text).trim();
        if (text.length === 0 || sendingRef.current) return;
        const accepted = owner.captureCurrentness();
        sendingRef.current = true;
        setSending(true);
        fireAndForget(onSendProp(text).then((sent) => {
            // Text typed while the question was on its way stays.
            if (sent) owner.clearAccepted(accepted);
        }).finally(() => {
            sendingRef.current = false;
            setSending(false);
        }), { tag: 'ReviewFollowUpComposer.send' });
    }, [onSendProp, owner]);

    const suggestFiles = React.useCallback((query: string, signal: AbortSignal) => resolveSessionComposerSuggestions(sessionId, query, {
        kinds: REVIEW_FOLLOW_UP_SUGGESTION_KINDS,
        signal,
    }), [sessionId]);

    const renderMark = React.useCallback((backendId: string) => (
        hasAgentIconMark(backendId, theme) ? <AgentIcon agentId={backendId} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} /> : null
    ), [theme]);
    const recipientChips = React.useMemo(
        () => [createRecipientChip(props.recipient, `${props.testID}:recipient`, renderMark)],
        [props.recipient, props.testID, renderMark],
    );

    return (
        <View testID={props.testID}>
            <AgentInput
                value={document.text}
                placeholder={props.placeholder}
                inputAccessibilityLabel={props.placeholder}
                onChangeText={onChangeText}
                structuredInputMentions={document.structuredInputMentions}
                onStructuredInputMentionsChange={onMentionsChange}
                onSend={send}
                isSending={sending}
                autocompleteKinds={REVIEW_FOLLOW_UP_SUGGESTION_KINDS}
                autocompleteSuggestions={suggestFiles}
                extraActionChips={recipientChips}
                engineControls="none"
                messageHistory="none"
            />
        </View>
    );
}

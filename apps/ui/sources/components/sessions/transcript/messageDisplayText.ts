import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';
import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readSessionHostOnboardingPresentationV1 } from '@happier-dev/protocol/sessions/creation/hostOnboardingPresentationV1';
import { t } from '@/text';
import {
    readUnsupportedContentMeta,
    resolveUnsupportedContentPresentation,
    type UnsupportedContentKind,
    type UnsupportedContentPresentation,
} from '@happier-dev/session-core/messages';
import { parseHappierMetaEnvelope, readTranscriptAttachmentsMeta } from './structured/happierMetaEnvelope';
export { readTranscriptAttachmentsMeta } from './structured/happierMetaEnvelope';
import { resolveUnsupportedContentLabel } from '@/sync/domains/messages/resolveUnsupportedContentLabel';
import { scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { readAgentStartupFailureCode, SESSION_PREPARATION_FAILURE_PREVIEWS, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionModelTransitionFailureStatus } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { projectInlineReferenceLabelsV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { resolveInlineMessageReference, resolveMessageStructuredReferences, type MessageStructuredReferences } from './references/messageStructuredReferences';
import { readRuntimeIssueMessageMeta } from './events/runtimeIssueMessage';
import { presentSessionTeamCredentialDenial } from '../presentation/sessionTeamCredentialDenialPresentation';
import { presentSessionAgentAuthRequired } from '../presentation/sessionAgentAuthRequiredPresentation';
import { formatSessionFailureLine, presentSessionRuntimeIssue } from '../presentation/sessionRuntimeIssuePresentation';
import { resolveSessionStartFailureNotice } from '../startFailure/sessionStartFailureNotice';

export type TranscriptMessageDisplayOptions = Readonly<{
    debugInformationEnabled?: boolean;
    thinkingDisplayMode?: Settings['sessionThinkingDisplayMode'];
    /** Selection callers already know whether an attachment row replaced the legacy suffix. */
    hasAttachmentBlockToStrip?: boolean;
    /** Only the Markdown chip renderer consumes the token-bearing source. */
    preserveInlineReferences?: boolean;
}>;

export type TranscriptMessageDisplayText = Readonly<{
    text: string | null;
    unsupportedContentText: string | null;
    isVoiceAgentTurn: boolean;
}>;

export function resolveTranscriptMessageDisplayText(
    message: UserTextMessage | AgentTextMessage,
    options: TranscriptMessageDisplayOptions = {},
): TranscriptMessageDisplayText {
    const prepared = prepareTranscriptMessageBody(message, options);
    const { isVoiceAgentTurn } = prepared;
    const unsupportedKind = readUnsupportedContentMeta(message.meta);
    const presentation = unsupportedKind
        ? resolveUnsupportedContentPresentation({ kind: unsupportedKind, debugInformationEnabled: options.debugInformationEnabled ?? false })
        : null;
    const unsupportedContentText = unsupportedKind && presentation
        ? resolveUnsupportedContentText({ kind: unsupportedKind, presentation, rawText: message.text })
        : null;
    if (presentation === 'hidden' || (message.kind === 'agent-text' && message.isThinking && options.thinkingDisplayMode === 'hidden')) {
        return { text: null, unsupportedContentText, isVoiceAgentTurn };
    }
    const text = unsupportedContentText ?? prepared.text;
    return { text, unsupportedContentText, isVoiceAgentTurn };
}

function unexplainedRuntimeIssueSummary(issue: SessionRuntimeIssueV1): string | null {
    const presented = presentSessionRuntimeIssue(issue);
    return presented.unexplained ? presented.summary : null;
}

/** Body preprocessing is shared with copy selection, which has its own eligibility contract. */
export function prepareTranscriptMessageBody(
    message: UserTextMessage | AgentTextMessage,
    options: Pick<TranscriptMessageDisplayOptions, 'hasAttachmentBlockToStrip' | 'preserveInlineReferences'> = {},
): Pick<TranscriptMessageDisplayText, 'text' | 'isVoiceAgentTurn'> {
    const isLegacyVoiceAgentTurn = parseHappierMetaEnvelope(message.meta)?.kind === 'voice_agent_turn.v1';
    const origin = readConversationTurnOriginV1FromMessageMeta(message.meta);
    const isVoiceAgentTurn = isLegacyVoiceAgentTurn
        || origin?.modality === 'voice'
        || (message.kind === 'user-text' && readSessionMessageProvenance(message.meta, 'stored')?.kind === 'voice');
    const hostOnboarding = message.kind === 'user-text' ? readHostOnboardingDisplayText(message.meta) : null;
    if (hostOnboarding !== null) return { text: hostOnboarding, isVoiceAgentTurn };
    const runtimeIssue = message.kind === 'agent-text' && !message.isThinking
        ? readRuntimeIssueMessageMeta(message.meta) : null;
    const teamDenial = message.kind === 'agent-text' && !message.isThinking
        ? presentSessionTeamCredentialDenial({ issue: runtimeIssue,
            // History has no catalog-name projection; do not infer one from
            // owner-private metadata or fetch a catalog per failure row.
            resolveResourceDisplayName: () => null })
        : null;
    const agentAuth = message.kind === 'agent-text' && !message.isThinking
        ? presentSessionAgentAuthRequired(runtimeIssue)
        : null;
    const usageLimitIssue = runtimeIssue?.source === 'usage_limit' || runtimeIssue?.code === 'usage_limit'
        ? presentSessionRuntimeIssue(runtimeIssue) : null;
    // Every failure row reads as one line through the line owner: what failed · its cause, ending as a sentence.
    const runtimeFailure = usageLimitIssue
        // Worded like the usage card's cause; the card owns the recovery action.
        ? formatSessionFailureLine([usageLimitIssue.summary, usageLimitIssue.reset])
        : runtimeIssue?.code === 'provider_model_not_found' || readAgentStartupFailureCode(runtimeIssue?.code) !== null
        ? formatSessionFailureLine([presentSessionRuntimeIssue(runtimeIssue).message, runtimeIssue?.failureCause?.providerErrorMessage])
        // A refused model change reads as its status; the Agent's own words wait in the row's Details.
        : readSessionModelTransitionFailureStatus(runtimeIssue?.code) !== null
            ? presentSessionRuntimeIssue(runtimeIssue).message
        // Other closed startup causes (preparation) read exactly as the Session's start-failure banner.
        : runtimeIssue && Object.hasOwn(SESSION_PREPARATION_FAILURE_PREVIEWS, runtimeIssue.code)
            ? formatSessionFailureLine([resolveSessionStartFailureNotice({ issue: runtimeIssue, sessionActive: false })?.message])
        // A failure no known cause explains reads as the plain line; the Agent's own text (SDK output, paths)
        // waits in Details. Rows with a known cause keep the words written for them.
        : runtimeIssue ? unexplainedRuntimeIssueSummary(runtimeIssue) : null;
    let text: string | null;
    if (teamDenial) text = formatSessionFailureLine([teamDenial.title, teamDenial.body]);
    else if (agentAuth) text = formatSessionFailureLine([agentAuth.message]);
    else if (runtimeFailure) text = runtimeFailure;
    else if (message.kind === 'user-text' && message.displayText !== undefined) text = message.displayText;
    else if (isLegacyVoiceAgentTurn) text = normalizeVoiceAgentTurnTranscriptText(message.text);
    else if (message.kind === 'user-text' && (options.hasAttachmentBlockToStrip ?? readTranscriptAttachmentsMeta(message.meta) !== null)) {
        text = stripLegacyAttachmentsBlock(message.text);
    } else text = message.text;
    if (text !== null && message.kind === 'agent-text' && message.isThinking) text = unwrapLegacyThinkingWrapper(text);
    if (text !== null && !(message.kind === 'user-text' && options.preserveInlineReferences)) {
        text = readableMessageText(text, message.kind === 'user-text' ? message.meta : undefined);
    }
    return { text, isVoiceAgentTurn };
}

/** Human readers never disclose token syntax; only typed message records supply markers. */
export function readableMessageText(text: string, meta?: unknown): string {
    const hostOnboarding = readHostOnboardingDisplayText(meta);
    if (hostOnboarding !== null) return hostOnboarding;
    if (meta == null) return projectInlineReferenceLabelsV1(text);
    return readableMessageTextWithReferences(text, resolveMessageStructuredReferences({ text, meta }).inline);
}

function readHostOnboardingDisplayText(meta: unknown): string | null {
    const provenance = readSessionMessageProvenance(meta, 'stored');
    if (provenance?.kind !== 'host' || provenance.producer !== 'hostOnboarding') return null;
    const facts = readSessionHostOnboardingPresentationV1(meta);
    return facts
        ? `${facts.authorDisplayName ? t('botTemplates.firstRunFromAuthor', { name: facts.authorDisplayName })
            : t('botTemplates.firstRunFromTemplate', { name: facts.templateName })} · v${facts.templateVersion}`
        : t('message.provenanceFrom', { source: 'Happier' });
}

/** Resource adapters supply typed bindings, never pretend their files are Session paths. */
export function readableMessageTextWithReferences(text: string, inline: MessageStructuredReferences['inline']): string {
    const tokens = scanInlineReferenceTokensV1(text);
    if (tokens.length === 0) return text;
    const chunks: string[] = [];
    let cursor = 0;
    for (const token of tokens) {
        const reference = resolveInlineMessageReference(inline, token.ref, text.slice(token.start, token.end), token.start);
        chunks.push(text.slice(cursor, token.start), reference?.marker ?? token.label);
        cursor = token.end;
    }
    chunks.push(text.slice(cursor));
    return chunks.join('');
}

export function resolveUnsupportedContentText(params: Readonly<{
    presentation: UnsupportedContentPresentation;
    kind: UnsupportedContentKind;
    rawText: string | null | undefined;
}>): string {
    if (params.presentation !== 'diagnostic') return resolveUnsupportedContentLabel(params.kind);
    const raw = typeof params.rawText === 'string' ? params.rawText.trim() : '';
    return raw.length > 0 ? raw : resolveUnsupportedContentLabel(params.kind);
}

export function stripLegacyAttachmentsBlock(text: string): string {
    const startTag = '[attachments]';
    const endTag = '[/attachments]';
    const start = text.indexOf(startTag);
    const end = text.indexOf(endTag);
    if (start < 0 || end < 0 || end <= start) return text;

    let stripStart = start;
    const intro = text.lastIndexOf('Attachments:', start);
    if (intro >= 0) {
        const lineStart = text.lastIndexOf('\n', intro - 1) + 1;
        if (lineStart === intro || text.slice(lineStart, intro).trim() === '') stripStart = lineStart;
    }
    const before = text.slice(0, stripStart).trimEnd();
    const after = text.slice(end + endTag.length).trimStart();
    if (!before) return after;
    if (!after) return before;
    return `${before}\n\n${after}`;
}

export function unwrapLegacyThinkingWrapper(text: string): string {
    const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
    return match ? match[1] : text;
}

import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { decodeStoredSessionMessages } from "@/storage/sessionMessageContent";
import { DiscussionAnchorV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { resolveEffectiveSessionAccessForSessionsInTx } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { createSessionDataKeyEnvelopeViewerSelect, resolveViewerSessionContentReadAvailability } from '@/app/session/encryption/sessionDataKeyEnvelopePersistence';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { readArtifactContentAvailabilityForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { artifactContextStorageAdapter } from '@/app/artifacts/artifactContextInjection';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { resolveDiscussionDocSourcesInTx, type DiscussionDocSource } from './docPassages';
import type { AdmittedDiscussionMessageRow, DiscussionRow } from './projection';
import { discussionFailure, discussionSuccess, type DiscussionFailureCode, type DiscussionResult } from './serviceTypes';

export type DiscussionQuoteSource = Readonly<{ kind: 'doc'; doc: DiscussionDocSource }>
    | Readonly<{ kind: 'session'; sessionId: string; messageId: string }>;

export function discussionQuoteSourceKey(source: DiscussionQuoteSource): string {
    return source.kind === 'doc' ? `doc:${source.doc.ref.artifactId}` : `session:${source.sessionId}:${source.messageId}`;
}

type QuoteTarget = Pick<AdmittedDiscussionMessageRow, 'id' | 'replyTargetV1'>;
type QuoteGroup = Readonly<{
    discussionId: string;
    discussion?: Pick<DiscussionRow, 'anchorV1'>;
}> & (
    | Readonly<{ rows: readonly QuoteTarget[]; storedTargets?: never }>
    | Readonly<{ storedTargets: readonly Readonly<{ id: string; replyTargetV1: unknown }>[]; rows?: never }>
);

/** One ancestry owner classifies quoted roots and inherited replies; unquoted chat stays independent. */
export async function resolveDiscussionQuoteSourcesInTx(tx: Tx, groups: readonly QuoteGroup[]):
    Promise<DiscussionResult<ReadonlyMap<string, ReadonlyMap<string, DiscussionQuoteSource | null>>>> {
    const anchors = new Map<string, { source: Extract<DiscussionQuoteSource, { kind: 'session' }>; rootId: string }>();
    // List, history, attention and Follow already hold the parent. Only quoted
    // Session anchors need their first-message identity; Docs use reply ancestry.
    const candidates = groups.filter(group => {
        if (!(group.rows ?? group.storedTargets).length) return false;
        if (!group.discussion) return true;
        const anchor = DiscussionAnchorV1Schema.safeParse(group.discussion.anchorV1);
        return anchor.success && anchor.data.kind === 'session' && Boolean(anchor.data.messageId);
    });
    for (const ids of portableQueryChunks({ values: candidates.map(group => group.discussionId), bindingsPerValue: 1, fixedBindings: 1 })) {
        const discussions = await tx.discussion.findMany({ where: { id: { in: [...ids] } }, select: {
            id: true, anchorV1: true, messages: { where: { seq: 1 }, select: { id: true } },
        } });
        for (const discussion of discussions) {
            const anchor = DiscussionAnchorV1Schema.safeParse(discussion.anchorV1);
            const root = discussion.messages[0];
            if (root && anchor.success && anchor.data.kind === 'session' && anchor.data.messageId) {
                anchors.set(discussion.id, { source: { kind: 'session', sessionId: anchor.data.sessionId, messageId: anchor.data.messageId }, rootId: root.id });
            }
        }
    }
    const result = new Map<string, ReadonlyMap<string, DiscussionQuoteSource | null>>();
    for (const group of groups) {
        const roots = new Map<string, string>();
        const docs = await resolveDiscussionDocSourcesInTx(tx, { discussionId: group.discussionId, rootMessageIds: roots,
            ...(group.rows ? { admittedMessages: group.rows } : { messages: group.storedTargets }) });
        if (!docs.ok) return docs;
        const anchor = anchors.get(group.discussionId);
        result.set(group.discussionId, new Map<string, DiscussionQuoteSource | null>([...docs.value].map(([id, doc]) => [id, doc ? { kind: 'doc', doc }
            : anchor && roots.get(id) === anchor.rootId ? anchor.source : null])));
    }
    return discussionSuccess(result);
}

/** Snapshot-local admission is batched by source identity, never by Discussion row.
 * Content/key owners decide readability. Executable reads additionally admit the current destination. */
export async function admitDiscussionQuoteSourcesInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication;
    sources: Iterable<DiscussionQuoteSource | null>; admissions: Map<string, DiscussionResult<void>>;
}>): Promise<void> {
    const sources = new Map<string, DiscussionQuoteSource>();
    for (const source of input.sources) if (source && !input.admissions.has(discussionQuoteSourceKey(source))) sources.set(discussionQuoteSourceKey(source), source);
    const sessions = [...sources.values()].filter((source): source is Extract<DiscussionQuoteSource, { kind: 'session' }> => source.kind === 'session');
    const sessionIds = [...new Set(sessions.map(source => source.sessionId))];
    const access = await resolveEffectiveSessionAccessForSessionsInTx(tx, { accountId: input.actorAccountId, sessionIds, authentication: input.authentication });
    const readySessions = new Map<string, 'plain' | 'encrypted'>();
    for (const ids of portableQueryChunks({ values: sessionIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        const rows = await tx.session.findMany({ where: { id: { in: [...ids] } }, select: withSessionContentSelect({
            id: true, ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: input.actorAccountId }),
            accountId: true, account: { select: RECIPIENT_READINESS_SELECT },
        }) }).then(decodeSessionStoredContent);
        for (const row of rows) if (access.get(row.id)?.capabilities.readTranscript
            && resolveViewerSessionContentReadAvailability(row, input.actorAccountId)) readySessions.set(row.id, row.encryptionMode === 'plain' ? 'plain' : 'encrypted');
    }
    const readableMessages = new Set<string>();
    for (const chunk of portableQueryChunks({ values: sessions, bindingsPerValue: 2, fixedBindings: 1 })) {
        const rows = await tx.sessionMessage.findMany({ where: { OR: chunk.map(source => ({ sessionId: source.sessionId, id: source.messageId })) },
            select: { contentBytes: true, id: true, sessionId: true, content: true } }).then(row => decodeStoredSessionMessages(row));
        for (const row of rows) {
            const envelope = SessionStoredMessageContentSchema.safeParse(row.content);
            if (envelope.success && envelope.data.t === readySessions.get(row.sessionId)) readableMessages.add(`session:${row.sessionId}:${row.id}`);
        }
    }
    const readableDocs = await readArtifactContentAvailabilityForCallerInTx(tx, { actorAccountId: input.actorAccountId,
        artifactIds: [...sources.values()].flatMap(source => source.kind === 'doc' ? [source.doc.ref.artifactId] : []) });
    for (const [key, source] of sources) {
        let admission: DiscussionResult<void> = (source.kind === 'doc' ? readableDocs.has(source.doc.ref.artifactId) : readableMessages.has(key))
            ? discussionSuccess(undefined) : discussionFailure('discussion_content_unavailable');
        if (admission.ok && input.authentication.contentDisclosureSessionId) {
            const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId, authentication: input.authentication,
                source: source.kind === 'doc' ? { kind: 'resource', resourceId: source.doc.ref.artifactId, adapter: artifactContextStorageAdapter }
                    : { kind: 'session', sessionId: source.sessionId },
                destination: { kind: 'session', sessionId: input.authentication.contentDisclosureSessionId } });
            if (!disclosure.ok) admission = discussionFailure('discussion_access_forbidden');
        }
        input.admissions.set(key, admission);
    }
}

/** Resolve the same quote-read failures for history and its attachment inventory. */
export async function resolveDiscussionQuoteReadabilityInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    authentication: SessionAccessAuthentication;
    groups: readonly QuoteGroup[];
    admissions?: Map<string, DiscussionResult<void>>;
}>) {
    const quotes = await resolveDiscussionQuoteSourcesInTx(tx, input.groups);
    if (!quotes.ok) return quotes;
    const admissions = input.admissions ?? new Map();
    const groups = [...quotes.value.values()];
    await admitDiscussionQuoteSourcesInTx(tx, { ...input, sources: groups.flatMap(group => [...group.values()]), admissions });
    const failures = new Map<string, DiscussionFailureCode>();
    for (const group of groups) {
        for (const [id, source] of group) {
            if (!source) continue;
            const admission = admissions.get(discussionQuoteSourceKey(source))!;
            if (!admission.ok) failures.set(id, admission.error);
        }
    }
    return discussionSuccess({ sources: quotes.value, failures });
}

import { DiscussionReplyTargetV1Schema, type DiscussionDocPassageReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import { DiscussionMessageContentV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { mayInjectResourceContextInTx, type ContextDisclosureResource } from '@/app/session/access/sessionContextInjection';
import { readArtifactForCallerInTx, resolveArtifactAudienceInTx } from '@/app/artifacts/artifactAccessService';
import { artifactContextStorageAdapter } from '@/app/artifacts/artifactContextInjection';
import type { Tx } from '@/storage/inTx';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';
import { getDbProviderFromEnv, prismaRuntime as sql } from '@/storage/prisma';
import { discussionJsonText, discussionSqlName as name } from './readSql';

export type DiscussionDocSource = DiscussionDocPassageReplyTargetV1['doc'];

/** Admit the source's full publication cohort before its parent; the reader below still decides disclosure. */
export async function readDiscussionDocSourceAuthorityAccountIdsInTx(tx: Tx, source: DiscussionDocSource | null): Promise<string[]> {
    if (!source) return [];
    return resolveArtifactAudienceInTx(tx, source.ref.artifactId);
}

/** New posts resolve the existing parent rather than inventing a pending message identity. */
export async function resolveDiscussionDocTargetInTx(tx: Tx, input: Readonly<{
    discussionId: string; replyTarget?: ReturnType<typeof DiscussionReplyTargetV1Schema.parse>;
}>): Promise<DiscussionResult<DiscussionDocSource | null>> {
    if (input.replyTarget?.kind !== 'message') return discussionSuccess(input.replyTarget?.kind === 'doc_passage' ? input.replyTarget.doc : null);
    const parent = await tx.discussionMessage.findFirst({ where: { discussionId: input.discussionId, id: input.replyTarget.messageId },
        select: { id: true, replyTargetV1: true } });
    if (!parent) return discussionFailure('discussion_invalid_reply_target');
    const resolved = await resolveDiscussionDocSourcesInTx(tx, { discussionId: input.discussionId, messages: [parent] });
    return resolved.ok ? discussionSuccess(resolved.value.get(parent.id) ?? null) : resolved;
}

/** Resolve root inheritance in batches, including roots outside the requested page. */
export async function resolveDiscussionDocSourcesInTx(tx: Tx, input: Readonly<{
    discussionId: string;
    /** Read projection reuses this same ancestry walk for Session-quoted roots. */
    rootMessageIds?: Map<string, string>;
}> & (Readonly<{ messages: readonly Readonly<{ id: string; replyTargetV1: unknown }>[]; admittedMessages?: never }>
    | Readonly<{ admittedMessages: readonly Readonly<{ id: string; replyTargetV1: ReturnType<typeof DiscussionReplyTargetV1Schema.parse> | null }>[]; messages?: never }>)
): Promise<DiscussionResult<ReadonlyMap<string, DiscussionDocSource | null>>> {
    const targets = new Map<string, ReturnType<typeof DiscussionReplyTargetV1Schema.parse> | null>(
        input.admittedMessages?.map(row => [row.id, row.replyTargetV1]));
    const messages = input.admittedMessages ?? input.messages!;
    let rows: readonly Readonly<{ id: string; replyTargetV1: unknown }>[] = input.messages ?? [];
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    for (;;) {
        for (const row of rows) {
            const parsed = row.replyTargetV1 == null ? null : DiscussionReplyTargetV1Schema.safeParse(row.replyTargetV1);
            if (parsed && !parsed.success) return discussionFailure('discussion_invalid_reply_target');
            targets.set(row.id, parsed?.success ? parsed.data : null);
        }
        const missing = [...new Set([...targets.values()].flatMap(target =>
            target?.kind === 'message' && !targets.has(target.messageId) ? [target.messageId] : []))];
        if (missing.length === 0) break;
        if (provider === 'mysql') {
            // MySQL's configured recursive-CTE depth can reject valid deep
            // threads. Retain its existing transport; PG/SQLite recurse below.
            rows = await tx.discussionMessage.findMany({ where: { discussionId: input.discussionId, id: { in: missing } },
                select: { id: true, replyTargetV1: true } });
            if (rows.length !== missing.length) return discussionFailure('discussion_invalid_reply_target');
            continue;
        }
        // One JSON parameter avoids PostgreSQL's 32,767-bind boundary,
        // regardless of the number of roots or ancestor depth.
        const ids = JSON.stringify(missing);
        const seeds = provider === 'sqlite' ? sql.sql`SELECT value AS id FROM json_each(${ids})`
            : sql.sql`SELECT value AS id FROM jsonb_array_elements_text(${ids}::jsonb)`;
        const inherited: { id: string; replyTargetV1: unknown }[] = await tx.$queryRaw(sql.sql`WITH RECURSIVE ancestors(id) AS (
            ${seeds}
            UNION
            SELECT parent.${name('id')} FROM ancestors a
            JOIN ${name('DiscussionMessage')} m ON m.${name('id')} = a.id AND m.${name('discussionId')} = ${input.discussionId}
            JOIN ${name('DiscussionMessage')} parent ON parent.${name('id')} = ${discussionJsonText(sql.sql`m.${name('replyTargetV1')}`, ['messageId'])}
                AND parent.${name('discussionId')} = ${input.discussionId}
            WHERE ${discussionJsonText(sql.sql`m.${name('replyTargetV1')}`, ['kind'])} = 'message'
        ) SELECT m.${name('id')}, m.${name('replyTargetV1')} FROM ${name('DiscussionMessage')} m
            JOIN ancestors a ON a.id = m.${name('id')} WHERE m.${name('discussionId')} = ${input.discussionId}`);
        // Raw SQLite JSON arrives as text; PG returns its native JSON value.
        try {
            for (const row of inherited) {
                if (targets.has(row.id)) continue;
                const value = provider === 'sqlite' && typeof row.replyTargetV1 === 'string' ? JSON.parse(row.replyTargetV1) as unknown : row.replyTargetV1;
                const parsed = value == null ? null : DiscussionReplyTargetV1Schema.safeParse(value);
                if (parsed && !parsed.success) return discussionFailure('discussion_invalid_reply_target');
                targets.set(row.id, parsed?.success ? parsed.data : null);
            }
        } catch { return discussionFailure('discussion_invalid_reply_target'); }
        if (missing.some(id => !targets.has(id)) || [...targets.values()].some(target => target?.kind === 'message' && !targets.has(target.messageId))) {
            return discussionFailure('discussion_invalid_reply_target');
        }
        break;
    }
    const sources = new Map<string, DiscussionDocSource | null>();
    for (const row of messages) {
        let id = row.id;
        const visited = new Set<string>();
        for (;;) {
            if (visited.has(id)) return discussionFailure('discussion_invalid_reply_target');
            visited.add(id);
            const target = targets.get(id);
            if (target?.kind !== 'message') {
                input.rootMessageIds?.set(row.id, id);
                sources.set(row.id, target?.kind === 'doc_passage' ? target.doc : null);
                break;
            }
            id = target.messageId;
        }
    }
    return discussionSuccess(sources);
}

/** A decoded plain payload cannot claim a different Doc from its admitted root. */
export function validateDiscussionDocContentSource(input: Readonly<{
    content: StrictSessionStoredMessageContentEnvelope; source: DiscussionDocSource | null; root: boolean;
}>): boolean {
    if (input.content.t === 'encrypted') return true;
    const parsed = DiscussionMessageContentV1StoredSchema.safeParse(input.content.v);
    if (!parsed.success) return false;
    const value = parsed.data;
    const passage = 'kind' in value
        ? value.kind === 'doc_passage_comment' ? value.passage : value.kind === 'doc_edit_proposal' ? value.proposal.target : null : null;
    if (!passage) return !input.root;
    // Both references are admitted on this authenticated Home. Profile labels
    // can differ across clients; the stored Artifact identity is authoritative.
    if (!input.source || passage.ref.artifactId !== input.source.ref.artifactId) return false;
    // A redo proposal may use a later revision in the same thread. A new root
    // binds its full source basis; replies inherit the original root identity.
    return !input.root || (passage.revision.headerVersion === input.source.revision.headerVersion
        && passage.revision.bodyVersion === input.source.revision.bodyVersion);
}

/** Quote writes and executable reads both reuse G's current source→destination policy. */
export async function admitDiscussionDocSourceInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication;
    source: DiscussionDocSource | null; destination?: ContextDisclosureResource;
}>): Promise<DiscussionResult<void>> {
    if (!input.source) return discussionSuccess(undefined);
    const read = await readArtifactForCallerInTx(tx, { actorAccountId: input.actorAccountId, artifactId: input.source.ref.artifactId });
    if (!read.ok) return discussionFailure('discussion_content_unavailable');
    if (input.destination) {
        const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
            authentication: input.authentication,
            source: { kind: 'resource', resourceId: input.source.ref.artifactId, adapter: artifactContextStorageAdapter },
            destination: input.destination });
        if (!disclosure.ok) return discussionFailure('discussion_access_forbidden');
    }
    return discussionSuccess(undefined);
}

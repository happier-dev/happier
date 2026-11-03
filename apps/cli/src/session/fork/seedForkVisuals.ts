import type { StoredCredentials } from '@/persistence';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionForkVisualCopyV1Schema, SessionForkVisualOriginV1Schema, type SessionForkVisualCopyV1 } from '@happier-dev/protocol/sessions/board';
import { SessionSurfaceItemV1StoredSchema } from '@happier-dev/protocol/sessions/board/item';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { getSessionTranscriptSurfaceItemReferenceSourceKeyV1, type SessionTranscriptSurfaceItemReferenceMemberV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { applyReducedMessages, createRawMessageNormalizationSequenceState, createReducer, normalizeRawMessageInSequence, reducer, type OrderedTranscript } from '@happier-dev/session-core';
import { configuration } from '@/configuration';
import { fetchSessionById, importHistoricalSessionTranscript, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { openSessionMessageContent, resolveExactSessionOrCredentialCryptoContext, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { createSessionBoardActionDeps } from '@/session/board/sessionBoardActionDeps';
import { openSessionSystemRecord } from '@/session/systemRecords/sessionSystemRecordCodec';
import { readSessionSystemRecordV1 } from '@/session/transport/http/sessionSystemRecordsHttp';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { logger } from '@/ui/logger';
import { fetchForkTranscriptSegments, type ForkTranscriptSegment } from '@/session/replay/fetchForkTranscriptSegments';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveTranscriptVisualReference } from '@/session/board/resolveTranscriptVisualReference';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type SeedParams = Readonly<{
    credentials: StoredCredentials;
    sourceSessionId: string;
    cutoffSeqInclusive: number;
    childSessionId: string;
    sourceRawSession?: RawSessionRecord;
    sourceMetadata?: Readonly<Record<string, unknown>>;
    accountEncryptionMode?: 'plain' | 'e2ee';
}>;

type VisualRow = { id: string; seq: number; raw: Record<string, unknown> };
type VisualCandidate = { message: ToolCallMessage; rows: readonly VisualRow[]; segment: ForkTranscriptSegment;
    crypto: SessionStoredContentCryptoContext };

async function readSegmentVisualCandidates(params: SeedParams, segment: ForkTranscriptSegment): Promise<VisualCandidate[]> {
    const sourceRaw = segment.rawSession;
    const sourceCrypto = resolveExactSessionOrCredentialCryptoContext(params, segment.sessionId, sourceRaw);
    if (!sourceCrypto) return [];
    const cutoffSeqInclusive = segment.upToSeqInclusive ?? sourceRaw.seq;
    const sequence = createRawMessageNormalizationSequenceState();
    const reduceState = createReducer();
    let transcript: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
    const rowsByToolId = new Map<string, VisualRow[]>();
    let afterSeq = 0;
    const sourceFork = record(segment.metadata?.forkV1);
    const hasInheritedSeed = Array.isArray(sourceFork?.visualCopies);
    const scanEndSeq = hasInheritedSeed ? Math.max(cutoffSeqInclusive, sourceRaw.seq) : cutoffSeqInclusive;
    try {
        for (;;) {
            const page = await fetchEncryptedTranscriptMessagesPage({ token: params.credentials.token, sessionId: segment.sessionId,
                scope: 'main', limit: configuration.replaySeedCandidateLimit, afterSeq });
            for (const row of [...page.messages].sort((a, b) => Number(a.seq) - Number(b.seq))) {
                if (typeof row.seq !== 'number' || typeof row.id !== 'string') continue;
                try {
                    const raw = record(openSessionMessageContent({ ...sourceCrypto, content: SessionStoredMessageContentSchema.parse(row.content) }));
                    if (!raw) continue;
                    // Inherited seed rows precede this Session's own segment in the
                    // canonical projection, irrespective of their child storage seq.
                    if (row.seq > cutoffSeqInclusive && (!hasInheritedSeed
                        || !createStoredReadSchema(SessionForkVisualOriginV1Schema).safeParse(record(raw.meta)?.forkVisualOriginV1).success)) continue;
                    const normalized = normalizeRawMessageInSequence({ id: row.id, localId: typeof row.localId === 'string' ? row.localId : null,
                        createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0, seq: row.seq, raw }, sequence);
                    if (!normalized) continue;
                    if (normalized.role === 'agent') {
                        for (const block of normalized.content) {
                            const toolId = block.type === 'tool-call' ? block.id : block.type === 'tool-result' ? block.tool_use_id : null;
                            if (!toolId) continue;
                            const rows = rowsByToolId.get(toolId) ?? [];
                            if (!rows.some(value => value.id === row.id)) rows.push({ id: row.id, seq: row.seq, raw });
                            rowsByToolId.set(toolId, rows);
                        }
                    }
                    transcript = applyReducedMessages(transcript, reducer(reduceState, [normalized], null).messages);
                } catch {
                    // One unreadable admitted row does not discard independent completed visuals.
                }
            }
            if (!page.hasMore || page.nextAfterSeq === null || page.nextAfterSeq >= scanEndSeq) break;
            if (page.nextAfterSeq <= afterSeq) throw new Error('Fork visual transcript cursor did not advance');
            afterSeq = page.nextAfterSeq;
        }
    } catch (error) {
        logger.debug('[fork] Visual transcript acquisition incomplete', { sourceSessionId: segment.sessionId, error });
    }
    return transcript.messageIdsOldestFirst.flatMap(id => {
        const message = transcript.messagesById[id];
        return message?.kind === 'tool-call' ? [{ message, rows: rowsByToolId.get(message.tool.id ?? '') ?? [], segment, crypto: sourceCrypto }] : [];
    });
}

/** Uses the ordinary lineage reader, reducer, Item Action and historical transcript writer. */
export async function seedForkVisualCopies(params: SeedParams): Promise<readonly SessionForkVisualCopyV1[]> {
    const copies: SessionForkVisualCopyV1[] = [];
    const [sourceRaw, childRaw] = await Promise.all([
        params.sourceRawSession ?? fetchSessionById({ reason: 'session-replay', token: params.credentials.token, sessionId: params.sourceSessionId }),
        fetchSessionById({ reason: 'session-replay', token: params.credentials.token, sessionId: params.childSessionId }),
    ]);
    if (!sourceRaw || !childRaw) return copies;
    const childCrypto = resolveExactSessionOrCredentialCryptoContext(params, params.childSessionId, childRaw);
    if (!childCrypto) return copies;
    const accountEncryptionMode = params.accountEncryptionMode ?? (await fetchAccountEncryptionCurrentness({ token: params.credentials.token })).mode;
    const { segments, acquisitionError } = await fetchForkTranscriptSegments({ credentials: params.credentials, accountEncryptionMode,
        startingSessionId: params.sourceSessionId, startingRawSession: sourceRaw, startingMetadata: params.sourceMetadata,
        upToSeqInclusive: params.cutoffSeqInclusive });
    if (acquisitionError !== undefined) logger.debug('[fork] Visual ancestry acquisition incomplete', { sourceSessionId: params.sourceSessionId, error: acquisitionError });
    const candidates: VisualCandidate[] = [];
    for (const segment of segments) candidates.push(...await readSegmentVisualCandidates(params, segment));

    const mutation = createSessionBoardActionDeps({ credentials: params.credentials }).sessionBoardAction;
    const activeServerId = configuration.activeServerId;
    const homeIdentityId = await resolveServerProfileHomeIdentityId(activeServerId);
    // Only the saved exact profile binding proves equivalence. Transcript hints
    // cannot authorize this Home's transport to read a different Home's records.
    const resolveServerScopeId = (id: string) => homeIdentityId && (id === activeServerId || id === homeIdentityId) ? homeIdentityId : null;
    const copiedByOrigin = new Map<string, { entry: SessionForkVisualCopyV1; revision: string | null }>();
    const lineageIndexBySessionId = new Map(segments.map((segment, index) => [segment.sessionId, index]));
    const importRows = new Map<string, { lineageIndex: number; sourceSeq: number;
        referencesBySource: Map<string, { originKey: string; reference: Pick<SessionTranscriptSurfaceItemReferenceMemberV1,
            'sourceAddress' | 'sourceItemId' | 'sourceItemRevision'> }>;
        item: { id: string; content: ReturnType<typeof sealSessionStoredContent> } }>();
    for (const { message, rows, segment, crypto: sourceCrypto } of candidates) {
        const originMeta = createStoredReadSchema(SessionForkVisualOriginV1Schema).safeParse(message.meta?.forkVisualOriginV1);
        const originAddress = originMeta.success
            ? { serverId: originMeta.data.serverId, sessionId: originMeta.data.sessionId }
            : { serverId: configuration.activeServerId, sessionId: segment.sessionId };
        const acknowledgedReference = await resolveTranscriptVisualReference({ toolName: message.tool.name, state: message.tool.state,
            input: message.tool.input, result: message.tool.result, address: originAddress });
        if (!acknowledgedReference || !areServerProfileIdentifiersEquivalent(acknowledgedReference.address.serverId,
            activeServerId, resolveServerScopeId)) continue;
        // One proven Home identity owns copy identity and imported provenance,
        // even when old and current acknowledgements use different profile labels.
        const reference = { ...acknowledgedReference, address: { ...acknowledgedReference.address,
            serverId: homeIdentityId ?? acknowledgedReference.address.serverId } };
        const sourceReference = { sourceAddress: reference.address, sourceItemId: reference.itemId, sourceItemRevision: reference.itemRevision };
        const sourceReferenceKey = getSessionTranscriptSurfaceItemReferenceSourceKeyV1(sourceReference);
        const origin = { originServerId: reference.address.serverId, originSessionId: reference.address.sessionId, originItemId: reference.itemId };
        const key = JSON.stringify(origin);
        let settled = copiedByOrigin.get(key);
        if (!settled || settled.entry.status === 'not_copied') {
            const existingCopyIndex = settled ? copies.indexOf(settled.entry) : -1;
            const itemId = createStableSpawnNonce('session.fork.visual', { childSessionId: params.childSessionId, ...origin });
            let entry: SessionForkVisualCopyV1 = { ...origin, status: 'not_copied' };
            let revision: string | null = null;
            try {
                // An inherited raw acknowledgement still names its original Session. The
                // source fork's settled map points to its independent local Item copy.
                const inherited = record(segment.metadata?.forkV1)?.visualCopies;
                const sourceCopy = Array.isArray(inherited) ? inherited.map(value => createStoredReadSchema(SessionForkVisualCopyV1Schema).safeParse(value))
                    .find(value => value.success && areServerProfileIdentifiersEquivalent(value.data.originServerId, origin.originServerId, resolveServerScopeId)
                        && value.data.originSessionId === origin.originSessionId && value.data.originItemId === origin.originItemId) : undefined;
                const sourceItemId = sourceCopy?.success && sourceCopy.data.status === 'copied' ? sourceCopy.data.itemId
                    : reference.address.sessionId === segment.sessionId ? reference.itemId : null;
                const address = { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: itemId } as const;
                const existing = await readSessionSystemRecordV1({ token: params.credentials.token, sessionId: params.childSessionId, address });
                if (existing) {
                    const item = SessionSurfaceItemV1StoredSchema.parse(openSessionSystemRecord(childCrypto, existing).content);
                    if (item.destination !== 'transcript') throw new Error('Fork visual destination mismatch');
                    entry = { ...origin, status: 'copied', itemId };
                    revision = existing.revision;
                } else if (sourceItemId) {
                    const stored = await readSessionSystemRecordV1({ token: params.credentials.token, sessionId: segment.sessionId,
                        address: { ...address, localId: sourceItemId } });
                    if (!stored) throw new Error('Fork visual source unavailable');
                    const sourceItem = SessionSurfaceItemV1StoredSchema.parse(openSessionSystemRecord(sourceCrypto, stored).content);
                    const item = { ...sourceItem, destination: 'transcript' as const,
                        ...(sourceItem.source.kind === 'widget' ? { source: { ...sourceItem.source, instance: { ...sourceItem.source.instance, id: itemId } } } : {}) };
                    const result = await mutation!({ actionId: 'session.board.item.upsert', context: {}, input: {
                        sessionId: params.childSessionId, itemId, expectedItemRevision: null, destination: 'transcript', item,
                    } });
                    const ack = record(record(result)?.result);
                    if (ack?.itemId !== itemId || typeof ack.itemRevision !== 'string') throw new Error('Fork visual copy was not acknowledged');
                    entry = { ...origin, status: 'copied', itemId };
                    revision = ack.itemRevision;
                }
            } catch (error) {
                logger.debug('[fork] Visual not copied', { childSessionId: params.childSessionId, ...origin, error });
            }
            settled = { entry, revision };
            copiedByOrigin.set(key, settled);
            if (existingCopyIndex >= 0) copies[existingCopyIndex] = entry;
            else copies.push(entry);
        }
        for (const row of rows) {
            const original = createStoredReadSchema(SessionForkVisualOriginV1Schema).safeParse(record(row.raw.meta)?.forkVisualOriginV1);
            // Preserve source-message provenance while carrying the recognized
            // Home identity, so another device need not know this CLI's profile label.
            const forkVisualOriginV1 = original.success ? { ...original.data, ...reference.address }
                : { v: 1 as const, ...reference.address, sourceMessageId: row.id, sourceSeq: row.seq };
            const id = createStableSpawnNonce('session.fork.visual-row', { childSessionId: params.childSessionId,
                serverId: forkVisualOriginV1.serverId, sessionId: forkVisualOriginV1.sessionId, sourceMessageId: forkVisualOriginV1.sourceMessageId });
            // The closest source copy wins, while the one historical writer retains
            // the admitted root-to-child transcript order for child-only readers.
            const existingRow = importRows.get(id);
            if (existingRow) {
                existingRow.referencesBySource.set(sourceReferenceKey, { originKey: key, reference: sourceReference });
                continue;
            }
            const lineageIndex = (areServerProfileIdentifiersEquivalent(forkVisualOriginV1.serverId, activeServerId, resolveServerScopeId)
                ? lineageIndexBySessionId.get(forkVisualOriginV1.sessionId) : undefined)
                ?? lineageIndexBySessionId.get(segment.sessionId)!;
            importRows.set(id, { lineageIndex, sourceSeq: forkVisualOriginV1.sourceSeq,
                referencesBySource: new Map([[sourceReferenceKey, { originKey: key, reference: sourceReference }]]),
                item: { id, content: sealSessionStoredContent({ ...childCrypto, idempotencyKey: id,
                payload: StrictJsonValueSchema.parse({ ...row.raw, meta: { ...record(row.raw.meta), forkVisualOriginV1 } }) }),
            } });
        }
    }
    try {
        // Historical imports already own local-id deduplication and never dispatch a turn.
        const items = [...importRows.values()].sort((a, b) => b.lineageIndex - a.lineageIndex || a.sourceSeq - b.sourceSeq).map(row => {
            const references: SessionTranscriptSurfaceItemReferenceMemberV1[] = [...row.referencesBySource.values()].flatMap(({ originKey, reference }) => {
                const settled = copiedByOrigin.get(originKey)!;
                return settled.entry.status === 'copied' && settled.revision ? [{ v: 1 as const,
                    itemId: settled.entry.itemId, itemRevision: settled.revision, ...reference }] : [];
            });
            return { ...row.item, ...(references.length > 0 ? { surfaceItemReference: { v: 1 as const, references } } : {}) };
        });
        await importHistoricalSessionTranscript({ token: params.credentials.token, sessionId: params.childSessionId, items });
    } catch (error) {
        logger.debug('[fork] Visual transcript seed unavailable', { childSessionId: params.childSessionId, error });
    }
    return copies;
}

/** Successful fork creation is never conditional on optional visual acquisition or copying. */
export async function seedForkVisualsBestEffort(params: Readonly<{
    credentials: StoredCredentials;
    sourceSessionId: string;
    cutoffSeqInclusive: number;
    childSessionId: string;
    sourceRawSession?: RawSessionRecord;
    sourceMetadata?: Readonly<Record<string, unknown>>;
}>): Promise<void> {
    try {
        const [childRaw, currentness] = await Promise.all([
            fetchSessionById({ reason: 'session-replay', token: params.credentials.token, sessionId: params.childSessionId }),
            fetchAccountEncryptionCurrentness({ token: params.credentials.token }),
        ]);
        if (!childRaw) return;
        const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials, rawSession: childRaw, accountEncryptionMode: currentness.mode });
        const fork = record(metadata?.forkV1);
        if (!fork || fork.parentSessionId !== params.sourceSessionId) return;
        // Presence settles the existing creation identity, including a truthful empty/failed seed.
        if (Array.isArray(fork.visualCopies)) return;
        const sourceRawSession = params.sourceRawSession ?? await fetchSessionById({ reason: 'session-replay', token: params.credentials.token, sessionId: params.sourceSessionId });
        const sourceMetadata = params.sourceMetadata ?? (sourceRawSession ? tryDecryptSessionOwnerMetadataView({
            credentials: params.credentials, rawSession: sourceRawSession, accountEncryptionMode: currentness.mode,
        }) : null);
        const copies = await seedForkVisualCopies({ ...params,
            accountEncryptionMode: currentness.mode,
            ...(sourceRawSession ? { sourceRawSession } : {}), ...(sourceMetadata ? { sourceMetadata } : {}),
            cutoffSeqInclusive: typeof fork.parentCutoffSeqInclusive === 'number' ? fork.parentCutoffSeqInclusive : params.cutoffSeqInclusive });
        await updateSessionMetadataWithRetry({ token: params.credentials.token, credentials: params.credentials, sessionId: params.childSessionId,
            rawSession: childRaw, accountEncryptionCurrentness: currentness, updater: current => {
                const existingFork = record(current.forkV1);
                if (!existingFork || existingFork.parentSessionId !== params.sourceSessionId || Array.isArray(existingFork.visualCopies)) return current;
                return { ...current, forkV1: { ...existingFork, visualCopies: [...copies] } };
            } });
        logger.debug('[fork] Visual seed settled', { childSessionId: params.childSessionId,
            copied: copies.filter(copy => copy.status === 'copied').length, notCopied: copies.filter(copy => copy.status === 'not_copied').length });
    } catch (error) {
        logger.debug('[fork] Visual seed unavailable; fork remains successful', { childSessionId: params.childSessionId, error });
    }
}

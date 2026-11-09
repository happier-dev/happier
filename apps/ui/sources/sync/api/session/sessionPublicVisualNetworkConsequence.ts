import { fetchSessionMessagesPage, openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { readPublishedSessionVisualMessages, type PublishedSessionVisualMessage } from '@happier-dev/session-core/transcript';
import { SessionExternalShareableMessagesPageV1Schema, SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { readSessionTranscriptSurfaceItemReferencesV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import type { UiSurfaceNetworkPolicyV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { isWidgetDefinitionPubliclyRenderableV1 } from '@happier-dev/protocol/widgets/widgetDefinitionV1';
import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board/item';
import { SESSION_BOARD_GET_MAX_LIMIT_V1, SessionBoardGetResultV1Schema } from '@happier-dev/protocol/sessions/board/actions';
import { readSessionVisualCapabilitiesV1 } from '@happier-dev/protocol/sessions/board';
import { isSessionSystemRecordRevisionAtLeastAcknowledged } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRevision';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { createSessionBoardActionAdapter } from './sessionBoardActions';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';

export type SessionPublicVisualNetworkConsequence = Readonly<{ status: 'ready'; visualCount: number; networkVisualCount: number;
    policies: readonly UiSurfaceNetworkPolicyV1[] }> | Readonly<{ status: 'unavailable' }>;

function publicItemNetwork(item: SessionSurfaceItemV1): UiSurfaceNetworkPolicyV1 | null {
    if (item.source.kind === 'widget' && item.source.instance.definition.kind === 'inline') {
        const definition = item.source.instance.definition.definition;
        if (!isWidgetDefinitionPubliclyRenderableV1(definition) || definition.body.kind !== 'html') return null;
    } else if (item.source.kind !== 'hostedHtml') return null;
    const normalized = readSessionVisualCapabilitiesV1(item);
    return normalized ? { network: normalized.network, networkOrigins: [...normalized.networkOrigins] } : null;
}

/** Lazy, explicit Share preparation: full published transcript, never the loaded UI window or Board inventory. */
export async function readSessionPublicVisualNetworkConsequence(options: Readonly<{
    scope: ServerAccountScope; sessionId: string; isCurrent?: () => boolean; signal?: AbortSignal;
}>): Promise<SessionPublicVisualNetworkConsequence> {
    try {
        return await runWithServerAccountScopeRequestGuard({ ...options,
            staleError: () => new Error('Public visual scope retired'),
        }, async ({ check, signal }) => runWithServerRequestAuthorityForServerAccountScope({ scope: options.scope,
            activeRequest: async () => { throw new Error('Public visual request requires exact Account authority'); },
        }, async authority => {
            const encryptionCurrentness = captureEncryptionGenerationCurrentness(authority.context.encryption, { serverId: options.scope.serverId });
            const assertCurrent = () => { check(); if (!encryptionCurrentness.isCurrent()) throw new Error('Public visual encryption scope retired'); };
            assertCurrent();
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId: options.sessionId,
                isCurrent: () => { assertCurrent(); return true; } });
            assertCurrent();
            if (session.access?.capabilities.readTranscript !== true) return { status: 'unavailable' as const };
            const encryption = authority.context.encryption?.getSessionEncryption(options.sessionId) ?? null;
            const contentContext: SessionStoredContentContext = session.encryptionMode === 'plain'
                ? { mode: 'plain' } : { mode: 'e2ee', encryption };
            if (contentContext.mode === 'e2ee' && !encryption) return { status: 'unavailable' as const };
            const messages: PublishedSessionVisualMessage[] = [];
            let beforeSeq: number | undefined;
            for (;;) {
                let rawPage: unknown;
                const page = await fetchSessionMessagesPage({ sessionId: options.sessionId, scope: 'main', projection: 'externalShareableV1',
                    ...(beforeSeq !== undefined ? { beforeSeq } : {}), signal,
                    requestJson: async (path, pageSignal) => {
                        assertCurrent();
                        const response = await authority.request(path, { signal: pageSignal });
                        assertCurrent();
                        if (!response.ok) throw new Error('Public transcript unavailable');
                        rawPage = await response.json();
                        assertCurrent();
                        return rawPage;
                    }, onParse: () => {
                        const published = SessionExternalShareableMessagesPageV1Schema.parse(rawPage);
                        if (published.publicationBlocked) throw new Error('Public transcript publication incomplete');
                        return SessionMessagesPageV1Schema.parse(published);
                    } });
                for (const message of page.messages) {
                    // Omission means the producer did not prove reference availability;
                    // explicit null means it proved this row has no admitted visual.
                    if (message.surfaceItemReference === undefined) return { status: 'unavailable' as const };
                    const opened = await openSessionStoredContent(contentContext, message.content);
                    assertCurrent();
                    if (opened.status !== 'ready') return { status: 'unavailable' as const };
                    messages.push({ id: message.id, seq: message.seq, localId: message.localId ?? null, createdAt: message.createdAt,
                        publishedSessionId: options.sessionId, raw: opened.value, reference: message.surfaceItemReference ?? null,
                        ...(message.messageRole ? { messageRole: message.messageRole } : {}), visualReadable: true });
                }
                if (page.hasMore === false) break;
                if (page.hasMore !== true || page.nextBeforeSeq == null || (beforeSeq !== undefined && page.nextBeforeSeq >= beforeSeq)) {
                    return { status: 'unavailable' as const };
                }
                beforeSeq = page.nextBeforeSeq;
            }
            const projection = readPublishedSessionVisualMessages(messages);
            const items = new Map<string, Readonly<{ reference: NonNullable<ReturnType<typeof readSessionTranscriptSurfaceItemReferencesV1>>[number]; occurrences: number }>>();
            let visualCount = 0;
            for (const message of messages) {
                const references = readSessionTranscriptSurfaceItemReferencesV1(message.reference) ?? [];
                for (const visual of projection.get(message.id) ?? []) if (visual.status === 'available') {
                    const reference = references[visual.referenceIndex];
                    if (!reference) return { status: 'unavailable' as const };
                    const previous = items.get(reference.itemId);
                    let latestReference = reference;
                    if (previous) {
                        if (isSessionSystemRecordRevisionAtLeastAcknowledged(previous.reference.itemRevision, reference.itemRevision)) {
                            latestReference = previous.reference;
                        } else if (!isSessionSystemRecordRevisionAtLeastAcknowledged(reference.itemRevision, previous.reference.itemRevision)) {
                            return { status: 'unavailable' as const };
                        }
                    }
                    items.set(reference.itemId, { reference: latestReference, occurrences: (previous?.occurrences ?? 0) + 1 });
                    visualCount++;
                }
            }
            const repository = createSessionSystemRecordRepository({ scope: authority.scope, request: authority.request });
            try {
                const board = createSessionBoardActionAdapter({ scope: authority.scope,
                    session: { serverId: authority.scope.serverId, sessionId: options.sessionId }, request: authority.request,
                    repository, contentContext, capabilities: { readTranscript: true, editSessionRecords: false }, boardEnabled: false });
                const policies: UiSurfaceNetworkPolicyV1[] = [];
                let networkVisualCount = 0;
                const referencedItems = [...items.values()];
                // Exact reads share the Board Action's existing item/page bound.
                for (let offset = 0; offset < referencedItems.length; offset += SESSION_BOARD_GET_MAX_LIMIT_V1) {
                    const batch = referencedItems.slice(offset, offset + SESSION_BOARD_GET_MAX_LIMIT_V1);
                    assertCurrent();
                    const read = await board({ actionId: 'session.board.get', input: {
                        sessionId: options.sessionId, itemIds: batch.map(({ reference }) => reference.itemId),
                    },
                        context: { serverId: authority.scope.serverId }, signal });
                    assertCurrent();
                    const parsed = SessionBoardGetResultV1Schema.safeParse(read);
                    if (!parsed.success || parsed.data.incomplete || parsed.data.sessionId !== options.sessionId
                        || parsed.data.serverId !== authority.scope.serverId || !parsed.data.capabilities.readTranscript) return { status: 'unavailable' as const };
                    const rowsById = new Map(parsed.data.items.map(row => [row.itemId, row]));
                    for (const { reference, occurrences } of batch) {
                        const row = rowsById.get(reference.itemId);
                        if (!row?.item || !isSessionSystemRecordRevisionAtLeastAcknowledged(row.revision, reference.itemRevision)) return { status: 'unavailable' as const };
                        if (row.item.destination !== 'transcript' && row.item.destination !== 'both') return { status: 'unavailable' as const };
                        const policy = publicItemNetwork(row.item);
                        if (policy && policy.network !== 'none') {
                            networkVisualCount += occurrences;
                            if (!policies.some(existing => JSON.stringify(existing) === JSON.stringify(policy))) policies.push(policy);
                        }
                    }
                }
                assertCurrent();
                return { status: 'ready' as const, visualCount, networkVisualCount, policies };
            } finally { repository.retire(); }
        }));
    } catch { return { status: 'unavailable' }; }
}

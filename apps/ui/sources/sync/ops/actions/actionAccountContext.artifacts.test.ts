import { projectBotTemplateArtifactHeaderV1, type BotTemplateDraftV1, type BotTemplateArtifactV1, projectBotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { createUiBotTemplateAction } from './botTemplateActionDeps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    createActionExecutor, ArtifactActionOutputSchemasV1, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, withArtifactExcerptV1,
    ActionsSettingsV1Schema, isApprovalRequiredByActionsSettings, normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as credentialStorage from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { createAccountArtifactStoredEnvelope, openArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { createWorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createSettingsDeclarationAction } from './settingsDeclarationAction';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { UsageCoachReversalSchema } from '@happier-dev/protocol/usage/coach/coachActions';
import { UsageCoachPreferencesV1Schema } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
import { createUiUsageActionPorts } from './usageActionDeps';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createUiMcpServerActionExecuteV1 } from './mcpServerActionDeps';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowMutationV1Schema, McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { UsageCoachApplyResultSchema } from '@happier-dev/protocol/usage/coach/coachActions';
import { decodeUsageQueryResource, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { DocEditAcceptTransportInputV1Schema, DocEditDeclineTransportInputV1Schema,
    DocEditDecisionResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionMessageV1Schema, DiscussionSummaryV1Schema, type DiscussionMessageV1,
    type DiscussionSummaryV1 } from '@happier-dev/protocol/discussions/models';
import { createResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { resourceStoredContentContext } from '@/sync/encryption/resourceStoredContent';
import { sealSessionStoredContent } from '@happier-dev/sync-client';
import { executeDiscussionActionInAccountContext } from '@/sync/api/discussions/discussionActions';
import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createDeferred } from '@/dev/testkit';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse, createPlainArtifactHttpFixture, projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

// HTTP, device credential storage and the native theme runtime are substituted boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
await loadSyncSingletonForTests();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function artifactKindProjection(storedKind: unknown) {
    const { kind, kindHint, classified } = decodeArtifactKindV1(storedKind);
    return { kind, ...(classified ? { kindHint } : {}) };
}
// Adapt the existing HTTP facts through the canonical Session batch fixture;
// Coach now reads exact Session snapshots, turns and messages on this transport.
function installSessionBatchHttpFixture(accountId: string, route: (url: unknown, init?: RequestInit) => Promise<Response>) {
    const boundary = createSessionReadBatchHttpBoundary(request => request.path === '/v2/sessions/read-batch' ? undefined
        : route(request.url, { method: request.method, headers: request.headers, signal: request.signal,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }));
    runtimeFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        return boundary.handle({ url, path: url.pathname, home: url.origin, accountId,
            method: init?.method ?? 'GET', headers: new Headers(init?.headers), signal: init?.signal,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    });
}
afterEach(() => { runtimeFetch.mockReset(); vi.restoreAllMocks(); });

describe('scoped Account workflow Artifact operations', () => {
    it.each([false, true])('admits only an owner-private template draft at release (shared=%s)', async shared => {
        const home = await upsertAndActivateServer({ serverUrl: `https://template-private-${shared}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const draftId = '7e23f798-230a-42f3-931f-e38b20736333';
        const releaseId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
        const draft: BotTemplateDraftV1 = { v: 1, state: 'draft', sourceSessionRef: { serverId: home.id, sessionId: 'source' }, releaseArtifactId: releaseId,
            content: { v: 1, identity: { name: 'Helper', description: '' }, instructions: { markdown: 'Help' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } }, candidates: { memoryRules: [], skills: [] } };
        const release = { v: 1 as const, state: 'released' as const, release: projectBotTemplateReleaseV1(draft, { version: '1.0.0', releasedAtMs: 1, changelog: '' }) };
        const envelopes: [string, BotTemplateArtifactV1][] = [[draftId, draft], [releaseId, release]];
        const rows = new Map(envelopes.map(([id, value]) => {
            const rawHeader = projectBotTemplateArtifactHeaderV1(value);
            return [id, { ...createPlainArtifactHttpFixture({ id, title: 'Helper', rawHeader, header: { title: 'Helper' }, body: JSON.stringify(value),
                isDecrypted: true, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'), ownerDisplayName: 'Maya Rowan' }] as const;
        }));
        runtimeFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: {} });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(JSON.parse(String(init?.body)), artifactId => ({ artifactId,
                ok: true, artifact: rows.get(artifactId), recipientCensus: null }));
            if (path.endsWith('/access/grants')) return json({ artifactId: path.includes(draftId) ? draftId : releaseId,
                ownerAccountId: 'artifact-account', access: 'owner', grants: shared && path.includes(draftId)
                    ? [{ principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', createdByAccountId: 'artifact-account', createdAt: 1, display: { name: 'Recipient' } }] : [] });
            if (path === `/v1/artifacts/${draftId}`) return json(rows.get(draftId));
            if (path === `/v1/artifacts/${releaseId}`) return json(rows.get(releaseId));
            throw new Error(`Unexpected route ${path}`);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createUiBotTemplateAction(account, () => {});
            const result = await execute({ actionId: 'template.release', input: { draftArtifactId: draftId,
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '' },
                context: { surface: 'ui', serverId: home.id, authority: 'present_user' } });
            expect(result).toMatchObject(shared ? { ok: false, errorCode: 'artifact_access_forbidden' } : { artifactId: releaseId, reused: true });
            const preview = await createActionExecutor(createActionExecutorBoundaryFixture({ botTemplateAction: args => execute(args) })).execute('template.preview',
                { source: { kind: 'artifact', serverId: home.id, artifactId: releaseId } },
                { surface: 'ui', serverId: home.id, authority: 'present_user' });
            expect(preview).toMatchObject({ ok: true, result: { presentation: { ownerDisplayName: 'Maya Rowan', shared: false } } });
        } finally { account.dispose(); }
    });
    it('opens only the demanded collection headers in one batch without bodies', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-visible-header-batch.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const rows = Array.from({ length: 1000 }, (_, index) => createPlainArtifactHttpFixture({
            id: `environment-${index}`, title: `Environment ${index}`, header: { title: `Environment ${index}` },
            rawHeader: { title: `Environment ${index}` }, body: 'Private unopened definition', isDecrypted: true,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        }, 'artifact-account'));
        const demanded = rows.slice(300, 400).map(row => row.id);
        const batches: unknown[] = [];
        runtimeFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: {} });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts/read') {
                const request: unknown = JSON.parse(String(init?.body));
                batches.push(request);
                return createArtifactReadBatchHttpResponse(request, artifactId => ({ artifactId, ok: true,
                    artifact: rows.find(row => row.id === artifactId), recipientCensus: null }));
            }
            throw new Error(`Unexpected route ${path}`);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const opened = await account.readArtifactHeaders(demanded);
            expect(opened).toHaveLength(100);
            expect(opened.every(result => result.status === 'fulfilled' && result.value?.isDecrypted
                && result.value.body === undefined)).toBe(true);
            expect(opened[0]).toMatchObject({ status: 'fulfilled', value: { id: 'environment-300', title: 'Environment 300' } });
            expect(batches).toEqual([{ artifactIds: demanded, projection: 'headers' }]);
        } finally { account.dispose(); }
    });
    it('shares neutral Artifact acquisition across captured invocations without borrowing caller cancellation', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-shared-captured-read.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const release = createDeferred<void>();
        const started = createDeferred<void>();
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let reads = 0;
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path !== `/v1/artifacts/${artifactId}`) throw new Error(`Unexpected route ${path}`);
            reads++;
            started.resolve();
            await release.promise;
            return json({ id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                header: encodePlainArtifactStoredContent({ title: 'Shared document' }),
                body: encodePlainArtifactStoredContent({ body: 'Current content' }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        });
        const caller = new AbortController();
        const first = await captureLazyActionAccountContext(home.id, caller.signal);
        const sibling = await captureLazyActionAccountContext(home.id);
        try {
            await Promise.all([first.resolveAccountMode(), sibling.resolveAccountMode()]);
            const abandoned = first.readArtifact(artifactId);
            const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
            const surviving = sibling.readArtifact(artifactId);
            await started.promise;
            caller.abort();
            release.resolve();
            await rejected;
            await expect(surviving).resolves.toMatchObject({ id: artifactId, body: 'Current content' });
            expect(reads).toBe(1);
        } finally { release.resolve(); first.dispose(); sibling.dispose(); }
    });

    it.each([{ mode: 'plain', accountMode: 'plain' }, { mode: 'e2ee', accountMode: 'e2ee' },
        { mode: 'plain', accountMode: 'e2ee' }] as const)('applies a reviewed $mode Doc proposal for a $accountMode Account through the existing codec and rejoins authoritative decisions', async ({ mode, accountMode }) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://doc-decision-${mode}-${accountMode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://doc-decision-other-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(accountMode === 'plain' ? { token }
            : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        let stored: Artifact | undefined;
        let thread: DiscussionSummaryV1 | undefined;
        let message: DiscussionMessageV1 | undefined;
        const decisionBodies: unknown[] = [];
        const recipientRequests: string[] = [];
        const countQueries: URL[] = [];
        const countWrites: string[] = [];
        let countThreads: DiscussionSummaryV1[] = [];
        let countingDoc = false;
        let proposalRef = { kind: 'discussion' as const, discussion: { serverId: home.id, discussionId: 'review' }, messageId: 'proposal' };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (countingDoc && target.pathname.startsWith('/v1/discussions')) countQueries.push(target);
            if (countingDoc && init?.method && init.method !== 'GET') countWrites.push(target.pathname);
            if (target.pathname === '/v1/account/encryption') return json({ mode: accountMode, updatedAt: 0 });
            if (target.pathname === '/v2/account/settings') return json({ content: null, version: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...write, ...projectArtifactStoredKind(write.kind), ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (stored && target.pathname === `/v1/artifacts/${stored.id}`) return json(stored);
            if (stored && target.pathname === `/v1/artifacts/${stored.id}/access/recipients`) {
                recipientRequests.push(target.pathname);
                return json({ artifactId: stored.id, ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: mode,
                    dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey,
                    provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                    callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] });
            }
            if (target.pathname === '/v1/discussions') {
                if (target.searchParams.get('anchorDocArtifactId') !== stored?.id || target.searchParams.get('state') !== 'active')
                    return json({ error: 'discussion_access_forbidden' }, 403);
                return target.searchParams.get('cursor') === 'doc-second'
                    ? json({ discussions: countThreads.slice(1), nextCursor: null })
                    : json({ discussions: countThreads.slice(0, 1), nextCursor: 'doc-second' });
            }
            if (target.pathname === '/v1/discussions/review') {
                if (countingDoc) return json({ error: 'discussion_access_forbidden' }, 403);
                return json({ discussion: thread });
            }
            if (target.pathname === '/v1/discussions/review/messages') {
                if (countingDoc) return json({ error: 'discussion_access_forbidden' }, 403);
                return json({ messages: [message], hasMoreOlder: false, messageSeq: 1 });
            }
            if (target.pathname === '/v1/artifacts/doc-edit-proposals/accept' || target.pathname === '/v1/artifacts/doc-edit-proposals/decline') {
                if (!stored || !message) throw new Error('Expected existing Doc and proposal');
                const accepting = target.pathname.endsWith('/accept');
                const body: unknown = JSON.parse(String(init?.body));
                decisionBodies.push(body);
                const acceptInput = accepting ? DocEditAcceptTransportInputV1Schema.parse(body) : undefined;
                const args = acceptInput ?? DocEditDeclineTransportInputV1Schema.parse(body);
                expect(args.proposalRef).toEqual(proposalRef);
                if (message.docEditProposalDispositionV1?.state === 'open') {
                    if (accepting) {
                        if (!acceptInput?.preparation) return json({ error: 'doc_edit_proposal_preparation_required' }, 409);
                        expect(acceptInput.preparation.doc).toEqual({ ref: { kind: 'doc', serverId: home.id, artifactId: stored.id },
                            revision: { headerVersion: 1, bodyVersion: 1 } });
                        stored = { ...stored, body: acceptInput.preparation.body, bodyVersion: 2 };
                        message = { ...message, docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 },
                            decidedBy: { accountId: 'artifact-account', atMs: 20 } } };
                    } else message = { ...message, docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'artifact-account', atMs: 20 } } };
                }
                return json(DocEditDecisionResultV1Schema.parse({ proposalRef, docEditProposalDispositionV1: message.docEditProposalDispositionV1 }));
            }
            return json({ error: 'unexpected_route' }, 404);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            let created: Pick<Awaited<ReturnType<typeof account.createArtifactDocument>>, 'artifactId' | 'revision'>;
            if (mode === accountMode) created = await account.createArtifactDocument({ header: { kind: 'artifact.legacy', title: 'Notes' }, body: 'Before secret passage after' });
            else {
                // An admitted plain document keeps its owner's mode when its editor uses E2EE.
                const envelope = await createAccountArtifactStoredEnvelope({ mode, header: { kind: 'artifact.legacy', title: 'Shared notes' },
                    body: { body: 'Before secret passage after' } });
                if (!envelope) throw new Error('Expected owner-produced plain Artifact envelope');
                stored = { ...envelope, id: 'shared-plain-doc', ownerAccountId: 'source-owner', access: 'edit', encryptionMode: mode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                created = { artifactId: stored.id, revision: { headerVersion: 1, bodyVersion: 1 } };
            }
            const { encryption } = await account.resolveAccountEncryption();
            const key = await createResourceDataKey({ mode: accountMode, ...(encryption ? { encryptDataEncryptionKey: (value: Uint8Array) => encryption.encryptEncryptionKey(value) } : {}) });
            if (!key) throw new Error('Expected canonical Discussion key');
            const title = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, title: 'Review' });
            const proposalContent = { kind: 'doc_edit_proposal', proposal: {
                target: { ref: { kind: 'doc', serverId: home.id, artifactId: created.artifactId }, revision: created.revision,
                    range: { start: 7, end: 21 }, quote: 'secret passage' }, baseRevision: created.revision,
                before: 'secret passage', after: 'reviewed replacement', reason: 'Clarify' } };
            const content = await sealSessionStoredContent(resourceStoredContentContext(key), proposalContent);
            if (title.status !== 'ready' || content.status !== 'ready') throw new Error('Expected canonical stored Discussion content');
            message = DiscussionMessageV1Schema.parse({ id: 'proposal', discussionId: 'review', localId: 'proposal-local', seq: 1,
                authorAccountId: 'artifact-account', accountActor: { v: 1, accountId: 'artifact-account', profile: null }, producerV1: null,
                content: content.content, mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc: {
                    ref: { kind: 'doc', serverId: home.id, artifactId: created.artifactId }, revision: created.revision } },
                docEditProposalDispositionV1: { state: 'open' }, createdAt: 1 });
            thread = DiscussionSummaryV1Schema.parse({ id: 'review', ownerAccountId: 'artifact-account', encryptionMode: accountMode,
                anchor: { kind: 'doc', doc: { ref: { kind: 'doc', serverId: home.id, artifactId: created.artifactId }, revision: created.revision } },
                access: 'owner', keyReadiness: true, dataEncryptionKey: key.dataEncryptionKey, creationLocalId: 'review-create', titleContent: title.content,
                latestMessage: { id: message.id, localId: message.localId, seq: 1, authorAccountId: message.authorAccountId,
                    accountActor: message.accountActor, producerV1: null, createdAt: 1 }, messageSeq: 1, lastReadSeq: 0,
                unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: ['artifact-account'], archivedAt: null,
                capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
                    sendToSession: true, manageAccess: true, leave: false } });
            const secondKey = await createResourceDataKey({ mode: accountMode,
                ...(encryption ? { encryptDataEncryptionKey: (value: Uint8Array) => encryption.encryptEncryptionKey(value) } : {}) });
            if (!secondKey) throw new Error('Expected independent second Discussion key');
            const secondContent = await sealSessionStoredContent(resourceStoredContentContext(secondKey), proposalContent);
            const secondTitle = await sealSessionStoredContent(resourceStoredContentContext(secondKey), { v: 1, title: 'Another review' });
            if (secondContent.status !== 'ready' || secondTitle.status !== 'ready') throw new Error('Expected canonical second Discussion content');
            const secondMessage = DiscussionMessageV1Schema.parse({ ...message, id: 'second-root', discussionId: 'second-review',
                localId: 'second-local', content: secondContent.content });
            countThreads = [DiscussionSummaryV1Schema.parse({ ...thread, firstMessage: message }),
                DiscussionSummaryV1Schema.parse({ ...thread, id: 'second-review', firstMessage: secondMessage,
                    titleContent: secondTitle.content, dataEncryptionKey: secondKey.dataEncryptionKey,
                    latestMessage: { ...thread.latestMessage, id: 'second-root', localId: 'second-local' } })];
            const artifactAction = createUiArtifactAction(account);
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction,
                discussionAction: args => executeDiscussionActionInAccountContext(account, 'available', args) })));
            const caller = { surface: 'ui' as const, serverId: home.id, expectedAccountId: 'artifact-account',
                authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            countingDoc = true;
            expect(await execute('doc.read', { ref: { kind: 'doc', serverId: home.id, artifactId: created.artifactId } }, caller))
                .toMatchObject({ ok: true, result: { openCommentCount: 2 } });
            countingDoc = false;
            expect(countQueries.map(query => query.pathname)).toEqual(['/v1/discussions', '/v1/discussions']);
            expect(countQueries.map(query => query.searchParams.get('anchorDocArtifactId'))).toEqual([created.artifactId, created.artifactId]);
            expect(countQueries.map(query => query.searchParams.get('cursor'))).toEqual([null, 'doc-second']);
            expect(countWrites).toEqual([]);
            const accepted = await execute('doc.edit.accept', { proposalRef, expectedRevision: created.revision }, caller);
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, result: { proposalRef,
                docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } } });
            if (!stored) throw new Error('Expected committed Doc');
            const dataKey = mode === 'e2ee' && encryption ? await encryption.decryptEncryptionKey(stored.dataEncryptionKey) : null;
            const opened = mode === 'plain' ? decodePlainArtifactStoredContent(stored.body!) : await new ArtifactEncryption(dataKey!).decryptBody(stored.body!);
            expect(opened).toEqual({ body: 'Before reviewed replacement after' });
            expect(recipientRequests).toEqual([]);
            if (mode === 'e2ee') expect(JSON.stringify(decisionBodies)).not.toContain('reviewed replacement');
            const client = createArtifactActionsClient({ serverId: home.id, accountId: 'artifact-account' }, execute);
            expect(await client.acceptEdit({ proposalRef, expectedRevision: created.revision })).toEqual({ ok: true, value: accepted.ok ? accepted.result : null });
            expect(await client.declineEdit({ proposalRef })).toEqual({ ok: true, value: accepted.ok ? accepted.result : null });
            expect(stored.bodyVersion).toBe(2);
            expect(decisionBodies).toHaveLength(3);
            expect(decisionBodies[1]).not.toHaveProperty('preparation');
            proposalRef = { ...proposalRef, messageId: 'decline-proposal' };
            message = { ...message, id: proposalRef.messageId, docEditProposalDispositionV1: { state: 'open' } };
            const declined = await client.declineEdit({ proposalRef });
            expect(declined).toMatchObject({ ok: true, value: { proposalRef, docEditProposalDispositionV1: { state: 'declined' } } });
            expect(await client.declineEdit({ proposalRef })).toEqual(declined);
            expect(await client.acceptEdit({ proposalRef, expectedRevision: created.revision })).toEqual(declined);
            expect(stored.bodyVersion).toBe(2);
            expect(decisionBodies).toHaveLength(6);
            expect(decisionBodies[5]).not.toHaveProperty('preparation');
            expect(await execute('doc.edit.accept', { proposalRef, expectedRevision: created.revision }, {
                ...caller, surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'session', sessionId: 'agent', starterDepth: 0, turnDepth: 0 },
                bypassApprovals: true, actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'doc.edit.accept': ['agent'] } }),
            } satisfies ActionExecutorContext)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(decisionBodies).toHaveLength(6);
            if (mode === 'e2ee') {
                message = { ...message, docEditProposalDispositionV1: { state: 'open' } };
                expect(await artifactAction({ actionId: 'doc.edit.accept', input: { proposalRef, expectedRevision: created.revision },
                    context: caller })).toMatchObject({ ok: false, errorCode: 'doc_edit_proposal_preparation_required' });
                expect(decisionBodies.at(-1)).toEqual({ proposalRef, expectedRevision: created.revision });
                expect(stored.bodyVersion).toBe(2);
            }
        } finally { account.dispose(); }
    });
    it('queries retained unused MCP evidence and applies and undoes rules through the canonical Action', async () => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://coach-binding.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'coach-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'usage.coach.apply': ['ui'], 'usage.coach.undo': ['ui'], 'mcp.rules.set': ['ui'],
        } });
        let catalog = McpServerCatalogV1Schema.parse({ v: 1,
            servers: [{ id: 'server', name: 'unused', transport: 'stdio', stdio: { command: 'fixture-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
            bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'machine', machineId: 'machine' }, createdAt: 1, updatedAt: 20 }],
        });
        let revision = 3;
        let witnessedRevision = 3;
        let witnessedBindingRevision = catalog.bindings[0]!.updatedAt;
        let witnessSequence = 1;
        let calls = 0;
        let coverage: 'complete' | 'partial' = 'complete';
        installSessionBatchHttpFixture('coach-account', async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: { actionsSettingsV1: actionsSettings } }, version: 1 });
            if (path === '/v2/usage/query') return json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
            if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method !== 'POST') return json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
                const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                if (mutation.expectedRevision !== revision) return json({ status: 'conflict', revision });
                if (mutation.content?.t !== 'plain') throw new Error('Expected exact plain catalog mutation');
                catalog = mutation.content.v;
                revision += 1;
                return json({ status: 'updated', revision, cursor: revision });
            }
            if (path === '/v2/sessions/coach-session') return json({ session: {
                id: 'coach-session', createdAt: 1, updatedAt: 900, seq: witnessSequence, active: true, activeAt: 900,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
                responsibleAccountId: null, responsibleAccount: null,
                metadataVersion: 1, metadata: JSON.stringify({ path: '/workspace/project', machineId: 'machine', agent: 'claude',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }),
                agentStateVersion: 1, agentState: null, share: null,
            } });
            if (path === '/v1/sessions/coach-session/turns') return json({ v: 1, sessionId: 'coach-session', updatedAt: 900, turns: [] });
            if (path === '/v1/sessions/coach-session/messages') {
                const usage = { v: 2, evidenceId: `mcp-window-${witnessSequence}`, sessionId: 'coach-session', turnId: `turn-${witnessSequence}`, observedAtMs: 300 + witnessSequence,
                    window: { startMs: 200 + witnessSequence, endMs: 300 + witnessSequence }, coverage, bindings: [{ serverId: 'server', bindingId: 'binding', catalogRevision: witnessedRevision,
                        bindingRevision: witnessedBindingRevision, serverRevision: 10, toolCallCount: calls, schemaBytes: null }] };
                return json({ messages: [{ id: `usage-row-${witnessSequence}`, seq: witnessSequence, localId: null, createdAt: 300,
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'mcp-event', data: { type: 'mcp-binding-usage', usage } } } } }], hasMore: false });
            }
            return json({ error: 'unexpected' }, 404);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'coach-account' }, settingsVersion: 1 });
        const account = await captureLazyActionAccountContext(home.id);
        let releaseUsage: (() => void) | undefined;
        try {
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                usageActions: createUiUsageActionPorts(account), mcpServerAction: createUiMcpServerActionExecuteV1(account),
                isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
                    context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context, undefined, undefined, input),
            }));
            const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings } as const;
            const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session: 'coach-session', timeZoneOffsetMinutes: 0 });
            const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
            releaseUsage = entry.subscribe(() => {}, true);
            const advanceNativeWindow = () => {
                witnessSequence += 1;
                // New retained HTTP content arrives with its exact Session wake.
                publishHomeAccountChange(home.id, ['coach-session'], { changeKinds: ['session'] });
            };
            const find = async () => {
                // The page owner refreshes changed native/catalog evidence;
                // the one-shot Action consumes that exact admitted snapshot.
                await entry.refresh();
                const result = await executor.execute('usage.query', { queries: [query] }, context);
                const batch = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined);
                expect(batch).toEqual(decodeUsageQueryResource(entry.getSnapshot().value!));
                expect(entry.getSnapshot().subscription).toBe('live');
                return batch.results[0]!.coach!.findings.find(row => row.detectorId === 'mcp_overhead');
            };
            let finding = await find();
            expect(finding).toMatchObject({ remedy: { kind: 'mcp_binding', bindingId: 'binding', serverId: 'server',
                target: { t: 'machine', machineId: 'machine' }, enabled: false, expectedRevision: 3 } });
            if (!finding) throw new Error('Expected witnessed unused binding finding from retained HTTP evidence');
            const refused = await executor.execute('usage.coach.apply', { query, evidenceKey: finding.evidenceKey }, {
                ...context, surface: 'agent', authority: 'account_automation', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
            });
            expect(refused).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(catalog.bindings[0]!.enabled).toBe(true);
            const apply = async (evidenceKey: string) => {
                const result = await executor.execute('usage.coach.apply', { query, evidenceKey }, context);
                expect(result.ok, JSON.stringify(result)).toBe(true);
                const receipt = UsageCoachApplyResultSchema.parse(result.ok ? result.result : undefined);
                if (!receipt.reversal) throw new Error('Expected exact MCP owner reversal');
                return receipt.reversal;
            };
            const reversal = await apply(finding.evidenceKey);
            expect(catalog.bindings[0]!.enabled).toBe(false);
            expect(reversal).toMatchObject({ kind: 'mcp_binding', owner: { serverId: 'server',
                rules: [{ id: 'binding', enabled: false }], previous: [{ id: 'binding', enabled: true }] } });
            // A successful remedy can remove its current proposal; its owner receipt still admits Undo.
            expect((await find())?.remedy ?? null).toBeNull();
            expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal }, context))
                .toMatchObject({ ok: true, result: { kind: 'undone' } });
            expect(catalog.bindings[0]!.enabled).toBe(true);
            // A new successful native window witnesses the configuration after Undo.
            witnessedRevision = revision;
            witnessedBindingRevision = catalog.bindings[0]!.updatedAt;
            advanceNativeWindow();
            finding = await find();
            if (!finding) throw new Error('Expected fresh binding witness after Undo');
            const staleReversal = await apply(finding.evidenceKey);
            const intervening = await executor.execute('mcp.rules.set', { items: [{ serverId: 'server' }],
                change: { kind: 'write', write: { place: { t: 'machine', machineId: 'machine' }, state: 'on' } } }, context);
            expect(intervening, JSON.stringify(intervening)).toMatchObject({ ok: true, result: { ok: true } });
            const afterIntervening = catalog;
            expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: staleReversal }, context))
                .toMatchObject({ ok: false, errorCode: 'coach_owner_refused' });
            expect(catalog).toBe(afterIntervening);
            expect(catalog.bindings[0]!.enabled).toBe(true);
            calls = 1;
            advanceNativeWindow();
            expect(await find()).toBeUndefined();
            calls = 0;
            coverage = 'partial';
            advanceNativeWindow();
            expect(await find()).toBeUndefined();
            coverage = 'complete';
            advanceNativeWindow();
            catalog = { ...catalog, servers: catalog.servers.map(server => ({ ...server, updatedAt: 11 })) };
            revision += 1;
            expect((await find())?.remedy ?? null).toBeNull();
        } finally { releaseUsage?.(); account.dispose(); storage.setState(previous); }
    });
    it.each([
        { scenario: 'owner', name: 'captures a setting at the committed CAS winner and restores its historical unset state, refusing intervening edits' },
        { scenario: 'coach', name: 'public Coach Undo re-queries actual Account HTTP and restores a real setting receipt, refusing intervening edits' },
        { scenario: 'coachPreferences', name: 'public Coach dismiss and snooze use retained Session composition HTTP and conditional Account preferences' },
        { scenario: 'scope', name: 'refuses a retained setting receipt in another Home and Account with the same settings version' },
        { scenario: 'history', name: 'restores exact captured unset state when Account settings history is disabled' },
        { scenario: 'preferences', name: 'updates declared Coach preferences with exact Account revision CAS' },
        { scenario: 'unset', name: 'preserves visible unset when restoring a scalar with no default' },
    ])('$name', async ({ scenario }) => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://settings-reversal.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'settings-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let raw: Record<string, unknown> = { futureSibling: { retained: true } };
        if (scenario === 'coach' || scenario === 'coachPreferences') raw.actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'usage.coach.apply': ['ui'], 'usage.coach.undo': ['ui'], 'usage.coach.dismiss': ['ui'],
                'usage.coach.snooze': ['ui'], 'settings.set': ['ui'] } });
        if (scenario === 'coach' || scenario === 'coachPreferences') raw.usageCoachPreferencesV1 = {
            v: 1, digestCadence: 'weekly', suppressions: [{ kind: 'dismissed', evidenceKey: 'another-finding' }],
        };
        let version = 4;
        let race = true;
        let retainHistory = true;
        const history = new Map<number, Record<string, unknown>>();
        installSessionBatchHttpFixture('settings-account', async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/usage/query') return json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
            if (path === '/v2/sessions/coach-session') return json({ session: {
                id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
                responsibleAccountId: null, responsibleAccount: null,
                metadataVersion: 1, metadata: JSON.stringify({ path: '/workspace/project', machineId: 'machine', agent: 'codex',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }),
                agentStateVersion: 1, agentState: null, share: null,
            } });
            if (path === '/v1/sessions/coach-session/turns') return json({ v: 1, sessionId: 'coach-session', updatedAt: 900, turns: [] });
            if (path === '/v1/sessions/coach-session/messages') {
                // This retained host event is an HTTP fixture, not model-native evidence or a prebuilt Coach evaluation.
                const composition = { v: 1, evidenceId: 'composition', sessionId: 'coach-session', turnId: 'turn', inputId: 'input',
                    observedAtMs: 300, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
                    components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64), kind: 'instructions',
                        location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })),
                    nativePrefix: null, contextWindowTokens: null };
                const admitsEvents = new URL(String(url)).searchParams.get('roles')?.split(',').includes('event');
                return json({ messages: admitsEvents ? [{ id: 'composition-row', seq: 1, localId: null, createdAt: 300,
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'composition-event',
                        data: { type: 'prompt-composition', composition } } } } }] : [], hasMore: false });
            }
            if (path.startsWith('/v2/account/settings/history/')) {
                const snapshotVersion = Number(path.split('/').at(-1));
                const snapshot = history.get(snapshotVersion);
                return snapshot ? json({ version: snapshotVersion, content: { t: 'plain', v: snapshot }, createdAt: '2026-10-09T00:00:00.000Z' }) : json({}, 404);
            }
            if (path === '/v2/account/settings') {
                if (init?.method !== 'POST') return json({ content: { t: 'plain', v: raw }, version });
                const write = JSON.parse(String(init.body)) as { expectedVersion: number; content: { t: string; v: Record<string, unknown> } };
                if (race) { race = false; raw = { ...raw, futureSibling: { retained: 'winner' } }; ++version; }
                if (write.expectedVersion !== version) return json({ success: false, error: 'version-mismatch', currentVersion: version,
                    currentContent: { t: 'plain', v: raw } });
                if (retainHistory) history.set(version, raw);
                raw = write.content.v;
                ++version;
                if (retainHistory) history.set(version, raw);
                return json({ success: true, version });
            }
            return json({ error: 'unexpected' }, 404);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'settings-account' }, settingsVersion: 4 });
        const account = await captureLazyActionAccountContext(home.id);
        let releaseUsage: (() => void) | undefined;
        const createAction = (captured: typeof account) => createSettingsDeclarationAction({ host: { os: 'web', desktop: false }, tauriDesktop: false,
            readPageGate: readSettingsPageGate, isFeatureEnabled: async () => true, isCurrent: captured.accountLifetime.isCurrent,
            readAccountSettings: captured.readSettings,
            accountScope: captured.accountLifetime.scope,
            readAccountSettingsSnapshot: captured.readRawSettingsSnapshot,
            writeAccountSettings: async delta => { await captured.mutateRawSettings(current => ({ ...current, ...delta })); },
            mutateAccountSettings: captured.mutateRawSettings,
            readLocalSettings: () => storage.getState().localSettings, writeLocalSettings: () => { throw new Error('unexpected local write'); },
        });
        const action = createAction(account);
        try {
            if (scenario === 'unset') {
                const anchor = 'sourceControl.includeCoAuthoredBy';
                expect.soft(await action({ actionId: 'settings.get', input: { anchor, includeVersion: true } }))
                    .toEqual({ anchor, unset: true, settingsVersion: 4 });
                const applied = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor, value: true, reversal: { kind: 'capture' } } }));
                expect(applied).toMatchObject({ reversal: { before: { unset: true }, applied: { value: true } } });
                const restored = await action({ actionId: 'settings.set', input: { anchor, value: false,
                    reversal: { kind: 'restore', ...applied.reversal } } });
                expect.soft(restored).toEqual({ anchor, unset: true, settingsVersion: 7 });
                expect(SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(restored).success).toBe(true);
                expect(Object.hasOwn(raw, 'scmIncludeCoAuthoredBy')).toBe(false);
                return;
            }
            if (scenario === 'preferences') {
                expect(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true } }))
                    .toEqual({ anchor: 'usage.coachPreferences', value: { v: 1, suppressions: [], disabledChecks: [], modelSuggestion: 'suggest_with_estimates' }, settingsVersion: 4 });
                const value = { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: 'finding' }],
                    disabledChecks: ['mcp_overhead'], modelSuggestion: 'complete_only' };
                race = false;
                expect(await action({ actionId: 'settings.set', input: { anchor: 'usage.coachPreferences', value, expectedSettingsVersion: 4 } }))
                    .toEqual({ anchor: 'usage.coachPreferences', value, settingsVersion: 5 });
                expect(raw).toEqual({ futureSibling: { retained: true }, usageCoachPreferencesV1: value });
                expect(await action({ actionId: 'settings.set', input: { anchor: 'usage.coachPreferences',
                    value: { ...value, suppressions: [] }, expectedSettingsVersion: 4 } }))
                    .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
                expect(raw.usageCoachPreferencesV1).toEqual(value);
                return;
            }
            if (scenario === 'history') {
                retainHistory = false;
                const applied = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } }));
                expect(applied).toMatchObject({ reversal: { beforeVersion: 5, appliedVersion: 6, before: { unset: true }, applied: { value: false } } });
                expect(history.size).toBe(0);
                expect(await action({ actionId: 'settings.set', input: { anchor: applied.anchor, value: false,
                    reversal: { kind: 'restore', ...applied.reversal } } })).toMatchObject({ anchor: applied.anchor, value: true });
                expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
                const inverted = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor: 'account.analytics', value: false, reversal: { kind: 'capture' } } }));
                expect(inverted).toMatchObject({ value: false, reversal: { before: { unset: true }, applied: { value: true } } });
                expect(raw.analyticsOptOut).toBe(true);
                expect(await action({ actionId: 'settings.set', input: { anchor: inverted.anchor, value: false,
                    reversal: { kind: 'restore', ...inverted.reversal } } })).toMatchObject({ anchor: inverted.anchor, value: true });
                expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
                return;
            }
            if (scenario === 'scope') {
                const applied = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } }));
                if (!applied.reversal) throw new Error('Missing owner reversal');
                const otherHome = await upsertAndActivateServer({ serverUrl: 'https://settings-other-home.test', scope: 'tab' });
                const otherToken = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'other-account' })), 'base64url')}.signature`;
                vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: otherToken });
                storage.setState({ settingsScope: { serverId: otherHome.id, accountId: 'other-account' }, settingsVersion: version });
                const otherAccount = await captureLazyActionAccountContext(otherHome.id);
                try {
                    expect(await createAction(otherAccount)({ actionId: 'settings.set', input: { anchor: applied.anchor, value: true,
                    reversal: { kind: 'restore', ...applied.reversal } } }))
                        .toMatchObject({ ok: false, errorCode: 'setting_reversal_scope_mismatch' });
                    expect(version).toBe(6);
                    expect(raw.showLineNumbers).toBe(false);
                } finally { otherAccount.dispose(); }
                return;
            }
            if (scenario === 'owner') {
            const applied = await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } });
            const firstReceipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(applied);
            expect(firstReceipt).toEqual({
                anchor: 'sourceControl.showLineNumbersInDiffs', value: false, settingsVersion: 6, reversal: { beforeVersion: 5, appliedVersion: 6,
                    scope: { serverId: home.id, accountId: 'settings-account' },
                    before: { unset: true }, applied: { value: false } },
            });
            for (const scope of [{ serverId: 'another-home', accountId: 'settings-account' }, { serverId: home.id, accountId: 'another-account' }]) {
                expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true,
                    reversal: { kind: 'restore', ...firstReceipt.reversal, scope } } }))
                    .toMatchObject({ ok: false, errorCode: 'setting_reversal_scope_mismatch' });
                expect(version).toBe(6);
                expect(raw.showLineNumbers).toBe(false);
            }
            expect(raw).toEqual({ futureSibling: { retained: 'winner' }, showLineNumbers: false });
            const restore = () => action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false,
                reversal: { kind: 'restore', ...firstReceipt.reversal } } });
            expect(await restore()).toMatchObject({ anchor: 'sourceControl.showLineNumbersInDiffs', value: true });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
            expect(await restore()).toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
            expect(await action({ actionId: 'settings.get', input: { anchor: 'sourceControl.showLineNumbersInDiffs', includeVersion: true } }))
                .toEqual({ anchor: 'sourceControl.showLineNumbersInDiffs', value: true, settingsVersion: 7 });
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, expectedSettingsVersion: 7 } }))
                .toEqual({ anchor: 'sourceControl.showLineNumbersInDiffs', value: false, settingsVersion: 8 });
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true, expectedSettingsVersion: 7 } }))
                .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' }, showLineNumbers: false });
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } }))
                .toEqual({ anchor: 'sourceControl.showLineNumbersInDiffs', value: false, settingsVersion: 8, reversalUnavailableReason: 'no_change' });
            const secondApply = await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true, reversal: { kind: 'capture' } } });
            const secondReceipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(secondApply);
            expect(secondApply).toMatchObject({ reversal: { beforeVersion: 8, appliedVersion: 9, before: { value: false }, applied: { value: true } } });
            // An unrelated CAS winner is safe to rebase over. To test refusal,
            // the intervening writer must actually change the captured setting.
            raw = { ...raw, showLineNumbers: false };
            version += 1;
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false,
                reversal: { kind: 'restore', ...secondReceipt.reversal } } }))
                .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' }, showLineNumbers: false });
            expect.soft(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true } }))
                .toEqual({ anchor: 'usage.coachPreferences', value: { v: 1, suppressions: [], disabledChecks: [], modelSuggestion: 'suggest_with_estimates' }, settingsVersion: 10 });
                return;
            }
            await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true } });
            const beforeVersion = version;
            const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0,
                ...(scenario === 'coachPreferences' ? { session: 'coach-session' } : {}) });
            // Undo deliberately needs no surviving finding. Its proof is the real
            // setting owner's receipt plus an authorized read through the actual query owner.
            const evidenceKey = 'captured-setting-receipt';
            const actionsSettings = (await account.readSettings()).actionsSettingsV1;
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                settingsDeclarationAction: args => action({ actionId: args.actionId, input: args.input, context: args.context }),
                usageActions: createUiUsageActionPorts(account),
                // This authenticated Account explicitly permits these effects. Its real parsed policy owns every nested decision.
                isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(actionId,
                    actionsSettings, context, undefined, undefined, input),
            }));
            const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings } as const;
            if (scenario === 'coachPreferences') {
                const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
                releaseUsage = entry.subscribe(() => {}, true);
                await entry.refresh();
                const queried = await executor.execute('usage.query', { queries: [query] }, context);
                const batch = UsageQueryBatchResultSchema.parse(queried.ok ? queried.result : undefined);
                expect(batch).toEqual(decodeUsageQueryResource(entry.getSnapshot().value!));
                expect(entry.getSnapshot().subscription).toBe('live');
                const finding = batch.results[0]?.coach?.findings.find(row => row.detectorId === 'duplicated_instructions');
                expect(finding).toMatchObject({ remedy: { kind: 'prepared_session' } });
                if (!finding) throw new Error('Expected actual retained-composition finding');
                const evidenceKey = finding.evidenceKey;
                const preferences = () => UsageCoachPreferencesV1Schema.parse(raw.usageCoachPreferencesV1);
                const otherSuppression = { kind: 'dismissed', evidenceKey: 'another-finding' };
                expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, dismissed: true } });
                expect(preferences()).toEqual({ v: 1, suppressions: [otherSuppression, { kind: 'dismissed', evidenceKey }],
                    disabledChecks: [], modelSuggestion: 'suggest_with_estimates' });
                await entry.refresh();
                const untilMs = Date.now() + 60_000;
                expect(await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, untilMs } });
                expect(preferences().suppressions).toEqual([otherSuppression, { kind: 'snoozed', evidenceKey, untilMs }]);
                await entry.refresh();
                expect(await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs: null }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, untilMs: null } });
                expect(preferences().suppressions).toEqual([otherSuppression]);
                await entry.refresh();
                await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context);
                await entry.refresh();
                race = true;
                expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context))
                    .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
                expect(preferences().suppressions).toEqual([otherSuppression, { kind: 'dismissed', evidenceKey }]);
                await entry.refresh();
                expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, dismissed: false } });
                expect(preferences()).toEqual({ v: 1, suppressions: [otherSuppression], disabledChecks: [], modelSuggestion: 'suggest_with_estimates' });
                return;
            }
            const capture = async () => {
                const applied = await executor.execute('settings.set', { anchor: 'sourceControl.showLineNumbersInDiffs', value: false,
                    reversal: { kind: 'capture' } }, context);
                expect(applied.ok, JSON.stringify(applied)).toBe(true);
                const receipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(applied.ok ? applied.result : undefined);
                if (!('value' in receipt) || !receipt.reversal) throw new Error('Expected real setting owner capture');
                return UsageCoachReversalSchema.parse({ kind: 'setting', anchor: receipt.anchor, appliedValue: receipt.value, owner: receipt.reversal });
            };
            const reversal = await capture();
            expect(reversal).toMatchObject({ kind: 'setting', owner: { beforeVersion, appliedVersion: beforeVersion + 1,
                before: { value: true }, applied: { value: false } } });
            expect(raw.showLineNumbers).toBe(false);
            const queried = await executor.execute('usage.query', { queries: [query] }, context);
            expect(queried).toMatchObject({ ok: true, result: { results: [{ accounting: { totals: { eventCount: 0 } } }] } });
            const undone = await executor.execute('usage.coach.undo', { query, evidenceKey, reversal }, context);
            expect(undone, JSON.stringify(undone))
                .toMatchObject({ ok: true, result: { kind: 'undone', evidenceKey } });
            expect(raw.showLineNumbers).toBe(true);
            const staleReversal = await capture();
            await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true } });
            expect(await executor.execute('usage.coach.undo', { query, evidenceKey, reversal: staleReversal }, context))
                .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw.showLineNumbers).toBe(true);
        } finally { releaseUsage?.(); account.dispose(); storage.setState(previous); }
    });
    it('admits a public-link-only WorkBoard audience for native reads without assuming unavailable publications are absent', async () => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-public-audience.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const row: Artifact = { id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', title: 'Board' }),
            body: encodePlainArtifactStoredContent({ body: '{}' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let publicAudience: unknown = 'retained';
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}`) return json({ ...row, publicAudience });
            if (path === `/v1/artifacts/${artifactId}/access/grants`) return json({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', grants: [] });
            if (path === '/v1/public-shares') return json({ error: 'not_found' }, 404);
            throw new Error(`Unexpected route ${path}`);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {} });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            await expect(account.readArtifactContent(artifactId)).resolves.toMatchObject({ shared: true, publicAudience: 'retained' });
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            await expect(account.workflowArtifacts.read(artifactId)).resolves.toMatchObject({ shared: true, publicAudience: 'retained' });
            expect(storage.getState().artifacts[artifactId]).toMatchObject({ publicAudience: 'retained' });
            const ordinary = createUiArtifactAction(account);
            expect(ArtifactActionOutputSchemasV1['artifact.get'].parse(await ordinary({ actionId: 'artifact.get',
                input: { artifactId }, context: { surface: 'ui' } }))).toMatchObject({ artifact: { publicAudience: 'retained' } });
            publicAudience = 'none';
            storage.setState({ artifacts: {} });
            await expect(account.readArtifactContent(artifactId)).resolves.toMatchObject({ shared: false });
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            await expect(account.workflowArtifacts.read(artifactId)).resolves.toMatchObject({ shared: false });
            for (const value of [undefined, 'future-audience']) {
                publicAudience = value;
                await expect(account.workflowArtifacts.read(artifactId)).rejects.toMatchObject({ code: 'content_unavailable' });
                expect(storage.getState().artifacts[artifactId]).toMatchObject({ publicAudience: 'unknown' });
            }
            expect(runtimeFetch.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/public-shares')).toBe(false);
        } finally { account.dispose(); storage.setState(previous); }
    });
    it('publishes admitted current reads once and removes a self-revoked Artifact without reopening it', async () => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-read-publication.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const row: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'view', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ title: 'Admitted' }),
            body: encodePlainArtifactStoredContent({ body: 'readable' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let revoked = false;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}/access/grants` && init?.method === 'DELETE') {
                revoked = true;
                return json({ artifactId, ownerAccountId: 'owner', access: null, grants: [], changed: true });
            }
            if (path === `/v1/artifacts/${artifactId}`) return revoked ? json({ error: 'Artifact not found' }, 404) : json(row);
            throw new Error(`Unexpected route ${path}`);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {}, artifactsLoaded: false });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            const artifactAction = createUiArtifactAction(account);
            const invocation = { actionId: 'artifact.get' as const, input: { artifactId }, context: { surface: 'ui' as const } };
            const quiet = await artifactAction({ ...invocation, readOnly: true });
            expect(quiet).toMatchObject({ artifact: { artifactId, body: 'readable', revision: { headerVersion: 1, bodyVersion: 1 } } });
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            expect(await artifactAction(invocation)).toEqual(quiet);
            const published = storage.getState().artifacts[artifactId];
            // One admitted read is not the list: the Library must keep loading, not show its first-visit state.
            expect(storage.getState().artifactsLoaded).toBe(false);
            expect(published).toMatchObject({ access: 'view', ownerAccountId: 'owner', isDecrypted: true, body: 'readable' });
            await artifactAction(invocation);
            expect(storage.getState().artifacts[artifactId]).toBe(published);
            await account.artifactAccessGrants.remove({ artifactId, principal: { kind: 'account', accountId: 'artifact-account' } });
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            await expect(account.fetchArtifact(artifactId)).resolves.toBeNull();
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
        } finally { account.dispose(); storage.setState(previous); }
    });
    it.each([
        ['create', 'credential'], ['update', 'credential'], ['create', 'caller'], ['update', 'caller'],
    ] as const)('keeps the %s acknowledgement after %s retirement without publishing stale content', async (operation, retirement) => {
        const previousState = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: `https://artifact-retired-${operation}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let retire: Parameters<typeof credentialStorage.subscribeHomeCredentialMutations>[0] | undefined;
        // Device credential subscription is the retirement boundary; codecs and Account fencing remain real.
        vi.spyOn(credentialStorage, 'subscribeHomeCredentialMutations').mockImplementation(listener => { retire = listener; return () => {}; });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const caller = new AbortController();
        const header = { title: 'Acknowledged', kind: 'home-hub-layout.v1', v: 1 };
        const body = 'acknowledged body';
        const before: Artifact = { id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ title: 'Before' }),
            body: encodePlainArtifactStoredContent({ body: 'before' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {} });
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}` && init?.method !== 'POST') return json(before);
            if (init?.method === 'POST' && (path === '/v1/artifacts' || path === `/v1/artifacts/${artifactId}`)) {
                if (retirement === 'credential') retire?.({ kind: 'credentials_removed', serverId: home.id, serverUrl: home.serverUrl });
                else caller.abort();
                if (operation === 'create') return json({ ...before, header: encodePlainArtifactStoredContent(header),
                    body: encodePlainArtifactStoredContent({ body }), headerVersion: 2, bodyVersion: 2 });
                return json({ success: true, headerVersion: 2, bodyVersion: 2 });
            }
            throw new Error(`Unexpected route ${path}`);
        });
        const account = await captureLazyActionAccountContext(home.id, caller.signal);
        try {
            if (operation === 'create') await expect(account.createArtifactDocument({ artifactId, header, body }))
                .resolves.toMatchObject({ artifactId, revision: { headerVersion: 2, bodyVersion: 2 }, artifact: { rawHeader: header, body } });
            else await expect(account.updateArtifactDocument({ artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header, body }))
                .resolves.toMatchObject({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
            expect(account.accountLifetime.isCurrent()).toBe(false);
            if (operation === 'create') expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            else expect(storage.getState().artifacts[artifactId]).toMatchObject({ body: 'before', headerVersion: 1, bodyVersion: 1 });
            await expect(account.fetchArtifact(artifactId)).rejects.toMatchObject(retirement === 'credential'
                ? { code: 'action_account_scope_changed' } : { name: 'AbortError' });
        } finally { account.dispose(); storage.setState(previousState); }
    });

    it.each(['plain', 'e2ee'] as const)('admits a shared plain typed binary body through the captured keyholding resource for a %s caller', async callerMode => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-binary-resource.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(callerMode === 'plain' ? { token }
            : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        const body = { blobId: '11111111-1111-4111-8111-111111111111', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) };
        const artifact = { id: 'binary-artifact',
            ownerAccountId: 'source-owner', access: 'edit', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            publicAudience: 'none', header: encodePlainArtifactStoredContent({ title: 'Image', kind: 'published.v1' }), body: encodePlainArtifactStoredContent({ body }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (target.pathname === '/v1/account/encryption') return json({ mode: callerMode, updatedAt: 0 });
            if (target.pathname === '/v1/artifacts/binary-artifact') return json(artifact);
            if (target.pathname === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(JSON.parse(String(init?.body)),
                artifactId => artifactId === artifact.id ? { artifactId, ok: true, artifact, recipientCensus: null }
                    : { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false });
            return json({ error: 'unexpected_route' }, 404);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            expect(await account.readArtifactPublicLinkResource('binary-artifact')).toMatchObject({ body, encryptionMode: 'plain', dataKey: null, access: 'edit' });
        } finally { account.dispose(); }
    });
    it('returns the committed Artifact create acknowledgement without depending on a subsequent read', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-create-acknowledgement.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://artifact-create-other-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const reads: string[] = [];
        let committed: Artifact | undefined;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                // Exact-id create may acknowledge an incumbent row after a same-id race.
                committed = { ...write, ...projectArtifactStoredKind(write.kind), ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
                    header: encodePlainArtifactStoredContent({ title: 'Incumbent' }), body: encodePlainArtifactStoredContent({ body: 'incumbent body' }),
                    provenance: null, provenanceDataEncryptionKey: null,
                    headerVersion: 3, bodyVersion: 4, seq: 4, createdAt: 1, updatedAt: 2 };
                return json(committed);
            }
            reads.push(target.pathname);
            return json({ error: 'read_transport_unavailable' }, 403);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            expect(await execute('artifact.create', { artifactId, header: { title: 'Attempted' }, body: 'attempted body' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 3, bodyVersion: 4 } } });
            expect(committed?.id).toBe(artifactId);
            expect(reads).toEqual([]);
            expect(await account.workflowArtifacts.create({ artifactId, header: {}, body: 'workflow body' })).toBe(artifactId);
            expect(reads).toEqual([]);
        } finally { account.dispose(); }
    });
    it.each([{ unclassified: false }, { unclassified: true }])('keeps indexed WorkBoard reads query-only with honest coverage (unclassified=$unclassified)', async ({ unclassified }) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://board-listing-${unclassified}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const row = (id: string, header: Record<string, unknown>, kind: NonNullable<Artifact['kind']> | null): Artifact => ({
            id, kind, ...(kind === null ? {} : { kindHint: typeof header.kind === 'string' ? header.kind : null }),
            ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: 'retained body' }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        });
        const board = (id: string) => ({ kind: 'work-board.v1', v: 1, title: id, pinnedInSessions: false, readsNeedsYou: false });
        const rows = [...Array.from({ length: 700 }, (_, index) => row(`other-${index}`, { kind: 'memory_doc.v1' }, 'other')),
            row('board-classified', board('board-classified'), 'work_board'),
            row('board-legacy', board('board-legacy'), unclassified ? null : 'work_board')];
        const urls: URL[] = [];
        const labeled: string[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if ((target.pathname === '/v1/artifacts/board-legacy' || target.pathname === '/v1/artifacts/query-hints/batch') && init?.method === 'POST') {
                const batched = target.pathname.endsWith('/batch');
                expect(JSON.parse(String(init.body))).toEqual(batched
                    ? { items: [{ artifactId: 'board-legacy', kind: 'v1:work_board:work-board.v1', expectedHeaderVersion: 1 }] }
                    : { kind: 'v1:work_board:work-board.v1', expectedHeaderVersion: 1 });
                const legacy = rows.at(-1)!;
                legacy.kind = 'work_board'; legacy.kindHint = 'work-board.v1';
                labeled.push(legacy.id);
                return json(batched ? { items: [{ artifactId: legacy.id, success: true }] } : { success: true });
            }
            if (target.pathname !== '/v1/artifacts') return json({ error: 'unexpected_route' }, 404);
            urls.push(target);
            expect(target.searchParams.has('includeBody')).toBe(false);
            if (!target.searchParams.has('kind') && !target.searchParams.has('unclassified')) return json({ error: 'unfiltered_inventory_forbidden' }, 400);
            return createArtifactListHttpResponse(target, rows);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            for (let index = 0; index < 2; index++) {
                const page = await account.workflowArtifacts.list({ coarseKind: 'work_board' });
                expect(page.items.map(item => item.artifactId).sort()).toEqual(unclassified
                    ? ['board-classified'] : ['board-classified', 'board-legacy']);
                expect(page.coverage).toBe(unclassified ? 'partial' : 'complete');
            }
            expect(labeled).toEqual([]);
            expect(urls.map(url => url.searchParams.get('unclassified') ?? url.searchParams.get('kind')))
                .toEqual(['work_board', 'work_board']);
        } finally { account.dispose(); }
    });
    it('selects ordinary Artifact lists across structural pages without leaking filters or truncating omitted limits', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://ordinary-artifact-selection.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const row = (id: string, title: string, kind: string, updatedAt: number, createdAt = updatedAt): Artifact => ({
            id, kind: 'other', kindHint: kind, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ title, kind }), body: encodePlainArtifactStoredContent({ body: 'retained body' }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt, updatedAt,
        });
        const rows = [...Array.from({ length: 500 }, (_, index) => row(`other-${index}`, 'Other', 'other.v1', 1000 - index)),
            row('zebra', 'Private zebra', 'published.v1', 2, 6000), row('alpha', 'Private alpha', 'published.v1', 1, 5000)];
        const urls: URL[] = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname !== '/v1/artifacts') return json({ error: 'unexpected_route' }, 404);
            urls.push(target);
            return createArtifactListHttpResponse(target, rows);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            const selected = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc', limit: 1 }, caller);
            expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, result: { items: [{ artifactId: 'alpha' }], nextCursor: expect.any(String) } });
            if (!selected.ok) throw new Error(selected.error);
            const first = ArtifactActionOutputSchemasV1['artifact.list'].parse(selected.result);
            expect(first.items.map(item => item.artifactId)).toEqual(['alpha']);
            const next = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc', limit: 1, cursor: first.nextCursor }, caller);
            expect(next).toMatchObject({ ok: true, result: { items: [{ artifactId: 'zebra' }] } });
            if (!next.ok) throw new Error(next.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(next.result).nextCursor).toBeUndefined();
            const created = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'created_desc' }, caller);
            if (!created.ok) throw new Error(created.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(created.result).items.map(item => item.artifactId)).toEqual(['zebra', 'alpha']);
            const complete = await execute('artifact.list', {}, caller);
            if (!complete.ok) throw new Error(complete.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(complete.result).items).toHaveLength(rows.length);
            const structural = await account.workflowArtifacts.list({ limit: 500, includeBody: true });
            expect(structural.items).toHaveLength(500);
            expect(structural.items[0]).toMatchObject({ body: 'retained body' });
            expect(structural.nextCursor).toBeDefined();
            for (const url of urls) {
                expect(url.searchParams.has('search') || url.searchParams.has('kind') || url.searchParams.has('sort')).toBe(false);
            }
        } finally { account.dispose(); }
    });
    it.each(['updated', 'changed-kind', 'missing', 'refused', 'locked'] as const)('readmits selected Artifact bodies and their fresh projection (%s)', async outcome => {
        const home = await upsertAndActivateServer({ serverUrl: `https://selected-artifact-${outcome}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const stored: Artifact = { id: 'selected-role', kind: 'other', kindHint: 'role.v1', ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'role.v1', title: 'Original' }),
            body: encodePlainArtifactStoredContent({ body: 'Original body' }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 };
        const currentHeader = { kind: outcome === 'changed-kind' ? 'memory_doc.v1' : 'role.v1', title: 'Current' };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts') {
                expect(target.searchParams.has('includeBody')).toBe(false);
                return createArtifactListHttpResponse(target, [stored]);
            }
            if (target.pathname === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(JSON.parse(String(init?.body)), artifactId => {
                expect(artifactId).toBe(stored.id);
                if (outcome === 'missing') return { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
                if (outcome === 'refused') return { artifactId, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: false };
                return { artifactId, ok: true, recipientCensus: null, artifact: { ...stored,
                    header: encodePlainArtifactStoredContent(currentHeader), body: encodePlainArtifactStoredContent({ body: 'Current body' }),
                    headerVersion: 2, bodyVersion: 3, seq: 4, createdAt: 5, updatedAt: 6,
                    ...(outcome === 'locked' ? { provenance: 'unreadable attribution' } : {}) } };
            });
            return json({ error: 'unexpected_route' }, 404);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const pending = account.workflowArtifacts.list({ kind: 'role.v1', includeBody: true });
            if (outcome === 'refused') await expect(pending).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
            else if (outcome === 'locked') await expect(pending).resolves.toMatchObject({ coverage: 'partial', items: [] });
            else if (outcome === 'missing' || outcome === 'changed-kind') await expect(pending).resolves.toMatchObject({ coverage: 'complete', items: [] });
            else await expect(pending).resolves.toMatchObject({ coverage: 'complete', items: [{ artifactId: stored.id,
                header: currentHeader, body: 'Current body', headerVersion: 2, bodyVersion: 3, seq: 4, createdAt: 5, updatedAt: 6 }] });
        } finally { account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('runs ordinary %s Artifact CRUD through the front door on the captured Home', async mode => {
        const home = await upsertAndActivateServer({ serverUrl: `https://ordinary-artifacts-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://ordinary-focused-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain' ? { token }
            : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let stored: Artifact | undefined;
        const recipientCensus = () => {
            if (!stored) throw new Error('Expected stored Artifact');
            return { artifactId: stored.id, ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: mode,
                dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey,
                provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] };
        };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === '/v2/account/settings') return json({ content: null, version: 0 });
            if (target.pathname === ARTIFACT_UPLOAD_PATH_V1 && init?.method === 'POST') {
                if (!(init.body instanceof ArrayBuffer)) throw new Error('Expected canonical binary upload');
                const frame = new Uint8Array(init.body);
                const metadata = decodeArtifactUploadMetadataV1(frame.subarray(0, frame.indexOf(10)));
                if (metadata.kind !== 'create') throw new Error('Expected publication create');
                stored = { id: metadata.artifactId, header: metadata.header, body: metadata.body, dataEncryptionKey: metadata.dataEncryptionKey,
                    ...artifactKindProjection(metadata.artifactKind),
                    provenance: metadata.provenance, provenanceDataEncryptionKey: metadata.provenanceDataEncryptionKey,
                    ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode, publicAudience: 'none',
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...write, ...artifactKindProjection(write.kind), ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode, publicAudience: 'none',
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (target.pathname === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(JSON.parse(String(init?.body)),
                id => stored?.id === id ? { artifactId: id, ok: true, artifact: stored, recipientCensus: mode === 'plain' ? null : recipientCensus() }
                    : { artifactId: id, ok: false, error: 'artifact_not_found', status: 404, retryable: false });
            if (stored && target.pathname.endsWith('/recipients')) return json(recipientCensus());
            if (stored && target.pathname === `/v1/artifacts/${stored.id}/html-preview`) return json({ url: `https://artifact-isolated.test/a/${stored.id}` });
            if (stored && init?.method === 'DELETE' && target.pathname === `/v1/artifacts/${stored.id}/revision/2/2`) {
                stored = undefined; return new Response(null, { status: 204 });
            }
            if (!stored || (target.pathname !== `/v1/artifacts/${stored.id}` && target.pathname !== `/v1/artifacts/${stored.id}/content/binary`)) return json({ error: 'not_found' }, 404);
            if (init?.method === 'DELETE') { stored = undefined; return new Response(null, { status: 204 }); }
            if (init?.method !== 'POST') return json(stored);
            const write = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (write.expectedHeaderVersion !== stored.headerVersion || write.expectedBodyVersion !== stored.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            stored = { ...stored, header: write.header!, body: write.body!, ...(write.kind === undefined ? {} : artifactKindProjection(write.kind)),
                provenance: write.provenance === undefined ? stored.provenance : write.provenance,
                provenanceDataEncryptionKey: write.provenanceDataEncryptionKey === undefined ? stored.provenanceDataEncryptionKey : write.provenanceDataEncryptionKey,
                headerVersion: 2, bodyVersion: 2 };
            return json({ success: true, headerVersion: 2, bodyVersion: 2 });
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'artifact.update': ['ui'], 'artifact.delete': ['ui'] } });
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
                artifactAction: createUiArtifactAction(context),
                isActionApprovalRequired: (id, actionContext, input) => isApprovalRequiredByActionsSettings(id,
                    actionContext.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), actionContext, undefined, undefined, input),
            })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const }, actionsSettings };
            expect(await execute('artifact.create', { artifactId, header: { title: 'First' }, body: 'initial' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
            const openedEnvelope = async () => {
                const row = stored!;
                if (mode === 'plain') return decodePlainArtifactStoredContent(row.body!);
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!);
                const key = await encryption!.decryptEncryptionKey(row.dataEncryptionKey);
                return new ArtifactEncryption(key!).decryptBody(row.body!);
            };
            const openedProvenance = async () => {
                const row = stored!;
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!) : null;
                const dataKey = row.provenanceDataEncryptionKey ? await encryption!.decryptEncryptionKey(row.provenanceDataEncryptionKey) : null;
                return openArtifactPrivateRevisionMetadata({ mode, artifactId: row.id, bodyVersion: row.bodyVersion!, provenance: row.provenance, dataKey });
            };
            const openedPublicHeader = async () => {
                const row = stored!;
                if (mode === 'plain') return decodePlainArtifactStoredContent(row.header);
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!);
                const key = await encryption!.decryptEncryptionKey(row.dataEncryptionKey);
                return new ArtifactEncryption(key!).decryptHeaderRaw(row.header);
            };
            expect(await openedEnvelope()).toEqual({ body: 'initial' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' } });
            expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            expect(await execute('artifact.get', { artifactId }, caller)).toMatchObject({ ok: true, result: { artifact: { artifactId, body: 'initial', header: { title: 'First' } } } });
            const listed = await execute('artifact.list', {}, caller);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { items: [{ artifactId, header: { title: 'First' } }] } });
            expect(await execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: { title: 'Second' }, body: 'changed' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
            expect(await openedEnvelope()).toEqual({ body: 'changed' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' } });
            expect(await execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: {}, body: 'stale' }, caller))
                .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            expect(await execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, caller))
                .toEqual({ ok: true, result: { artifactId, deleted: true } });
            expect(await execute('artifact.get', { artifactId }, caller)).toEqual({ ok: true, result: { artifact: null } });
            expect(await execute('artifact.publish_from_file', { path: 'result.txt' }, caller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(await execute('artifact.publish_from_file', { path: 'result.txt' }, { ...caller, defaultSessionId: 'publication-session' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            storage.setState({ sessions: { 'publication-session': createSessionFixture({ id: 'publication-session', serverId: home.id,
                metadata: { ...createSessionFixture().metadata!, path: '/workspace', machineId: 'publication-machine' } }) },
                machineListByServerId: { [home.id]: [createMachineFixture({ id: 'publication-machine' })] } });
            const download = vi.fn(async (request: { signal?: AbortSignal | null; destination: { writeBytes: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void> } }) => {
                await request.destination.writeBytes(new TextEncoder().encode('<h1>Published</h1>'));
                await request.destination.close();
                return { ok: true as const, name: 'result.html', sizeBytes: 18 };
            });
            // This port is the remote workspace byte-transport boundary; Session lookup and publication remain real.
            // Session provenance retains the Agent approval floor. Use the real persisted waiver policy for this admitted source test.
            const publicationSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                'artifact.publish_from_file': ['agent'], 'artifact.update': ['ui'],
            } });
            const publication = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(context, {
                workspaceDownload: download,
            }), isActionApprovalRequired: (actionId, actionContext, input) => isApprovalRequiredByActionsSettings(
                actionId, publicationSettings, actionContext, undefined, undefined, input,
            ) })));
            const publicationCaller = { kind: 'session', sessionId: 'publication-session', starterDepth: 0, turnDepth: 0 } satisfies NonNullable<ActionExecutorContext['actionCaller']>;
            const sessionCaller = { ...caller, serverId: home.id, runtimeAccountId: 'artifact-account',
                defaultSessionId: 'publication-session', actionCaller: publicationCaller };
            expect(await execute('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(stored).toBeUndefined();
            expect(download).not.toHaveBeenCalled();
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, runtimeAccountId: 'other-account' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, serverId: 'other-home' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(download).not.toHaveBeenCalled();
            const publishedResult = await publication('artifact.publish_from_file', { path: 'result.html' }, sessionCaller);
            expect(publishedResult).toEqual({ ok: true, result: { artifactId: expect.any(String), revision: { headerVersion: 1, bodyVersion: 1 } } });
            expect(publishedResult).not.toHaveProperty('result.previewUrl');
            expect(publishedResult).not.toHaveProperty('result.previewError');
            expect(JSON.stringify(publishedResult)).not.toContain('#d=');
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'agent', accountId: 'artifact-account', sessionId: 'publication-session' }, source: {
                sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.html', sha: expect.any(String),
            } });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toEqual({ body: '<h1>Published</h1>' });
            expect(download).toHaveBeenCalledWith(expect.objectContaining({ serverId: home.id, machineId: 'publication-machine', rootPath: '/workspace', confinedToWorkingDirectory: true }));
            const published = stored;
            const publishedRead = await publication('artifact.get', { artifactId: published!.id }, caller);
            expect(publishedRead).toMatchObject({ ok: true, result: { artifact: { body: '<h1>Published</h1>', header: { kind: 'html' }, provenance: {
                source: { sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.html', sha: expect.any(String) } } } } });
            expect(publishedRead).not.toHaveProperty('result.previewUrl');
            const calls = download.mock.calls.length;
            expect(await publication('artifact.publish_from_file', { path: '../private.txt' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
            expect(download).toHaveBeenCalledTimes(calls);
            const cancellation = new AbortController();
            download.mockImplementationOnce(async (request) => {
                await request.destination.writeBytes(new TextEncoder().encode('<h1>Cancelled</h1>'));
                cancellation.abort();
                expect(request.signal?.aborted).toBe(true);
                return { ok: true, name: 'result.html', sizeBytes: 18 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, signal: cancellation.signal }))
                .toMatchObject({ ok: false });
            expect(stored).toBe(published);
            download.mockImplementationOnce(async () => {
                const session = storage.getState().sessions['publication-session'];
                storage.setState({ sessions: { 'publication-session': { ...session, metadata: { ...session.metadata!, path: '/different-workspace' } } } });
                return { ok: true, name: 'result.html', sizeBytes: 18 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(stored).toBe(published);
            download.mockImplementationOnce(async request => {
                await request.destination.writeBytes(new Uint8Array([0, 255, 128, 42]));
                await request.destination.close();
                return { ok: true, name: 'result.bin', sizeBytes: 4 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.bin', mime: 'application/octet-stream' }, sessionCaller))
                .toMatchObject({ ok: true });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toMatchObject({ body: { mime: 'application/octet-stream', sizeBytes: 4 } });
            expect(await openedEnvelope()).not.toHaveProperty('provenance');
            const binarySource = (await openedProvenance())!.source;
            expect(binarySource).toMatchObject({ sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.bin', sha: expect.any(String) });
            expect(await publication('artifact.update', { artifactId: stored!.id, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                header: { title: 'Rewritten', source: { sessionId: 'forged' } }, body: 'replacement' }, caller)).toMatchObject({ ok: true });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toEqual({ body: 'replacement' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' }, source: binarySource });
        } finally { context.dispose(); }
    });
    it('cancels an operation-scoped async Settings transform before its durable write', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://profile-mutation-cancellation.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'profile-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let raw: Record<string, unknown> = { futureSibling: { retained: true } };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const write = JSON.parse(String(init.body)) as { content: { v: Record<string, unknown> } };
                    raw = write.content.v;
                    return json({ success: true, version: 5 });
                }
                return json({ content: { t: 'plain', v: raw }, version: 4 });
            }
            return json({ error: 'unexpected' }, 404);
        });
        const context = await captureLazyActionAccountContext(home.id);
        const controller = new AbortController();
        let began!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => { began = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        try {
            const mutation = context.mutateRawSettings(async current => {
                began();
                await held;
                return { ...current, showLineNumbers: false };
            }, { signal: controller.signal });
            const rejected = expect(mutation).rejects.toMatchObject({ name: 'AbortError' });
            await started;
            controller.abort();
            release();
            await rejected;
            expect(raw).toEqual({ futureSibling: { retained: true } });
            expect(await context.readRawSettings()).toEqual(raw);
        } finally { release(); context.dispose(); }
    });

    it.each(['operation', 'invocation', 'account'] as const)('preserves an acknowledged Settings effect after %s retirement without publishing into a replacement Account', async (retirement) => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: `https://settings-receipt-${retirement}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const invocation = new AbortController();
        const operation = new AbortController();
        const replacementScope = { serverId: home.id, accountId: 'replacement-account' };
        let raw: Record<string, unknown> = { futureSibling: { retained: true } };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method !== 'POST') return json({ content: { t: 'plain', v: raw }, version: 4 });
                const write = JSON.parse(String(init.body)) as { content: { v: Record<string, unknown> } };
                raw = write.content.v;
                // The transport has an actual durable success, but the invoker retires
                // while consuming its receipt. Only content disclosure remains scoped.
                return Object.assign(json({ success: true, version: 5 }), { json: async () => {
                    storage.setState({ settingsScope: replacementScope, settingsVersion: 77 });
                    if (retirement === 'operation') operation.abort();
                    else if (retirement === 'invocation') invocation.abort();
                    else await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'replacement-account' });
                    return { success: true, version: 5 };
                } });
            }
            return json({ error: 'unexpected' }, 404);
        });
        const context = await captureLazyActionAccountContext(home.id, invocation.signal);
        try {
            await expect(context.mutateRawSettings(current => ({ ...current, showLineNumbers: false }), { signal: operation.signal }))
                .resolves.toMatchObject({ status: 'applied', settingsVersion: 5 });
            expect(raw).toEqual({ futureSibling: { retained: true }, showLineNumbers: false });
            expect(storage.getState().settingsScope).toEqual(replacementScope);
            expect(storage.getState().settingsVersion).toBe(77);
        } finally { context.dispose(); storage.setState(previous); }
    });

    it('rejects captured-scope retirement before dispatch and after an asynchronous read', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-retirement.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let releaseRead: (() => void) | undefined;
        let readStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => { readStarted = resolve; });
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts/held') {
                readStarted!();
                await new Promise<void>((resolve) => { releaseRead = resolve; });
                return json({ error: 'missing' }, 404);
            }
            return json({});
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const pending = context.workflowArtifacts.read('held');
            const rejected = expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            await started;
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'replacement-account' })).toBe(true);
            releaseRead!();
            await rejected;
            const dispatched = runtimeFetch.mock.calls.length;
            await expect(context.workflowArtifacts.delete('held')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(runtimeFetch.mock.calls).toHaveLength(dispatched);
        } finally { context.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('reads, pages, creates, CAS-updates and deletes %s content on the captured Home', async (mode) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://workflow-artifacts-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://focused-artifacts-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain'
            ? { token } : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        let stored: Artifact | undefined;
        const recipientCensus = () => {
            if (!stored) throw new Error('Expected stored Artifact');
            return { artifactId: stored.id, ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: stored.encryptionMode,
                dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey,
                provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] };
        };
        const requests: URL[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            requests.push(target);
            expect(target.origin).toBe(home.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...body, ...artifactKindProjection(body.kind), ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode, publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 9 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (target.pathname === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(JSON.parse(String(init?.body)), id => {
                if (id === 'transport-error') return { artifactId: id, ok: false, error: 'artifact_access_forbidden', status: 403, retryable: false };
                if (id === 'locked') return { artifactId: id, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: false };
                return stored?.id === id ? { artifactId: id, ok: true, artifact: stored, recipientCensus: mode === 'plain' ? null : recipientCensus() }
                    : { artifactId: id, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
            });
            if (target.pathname.endsWith('/transport-error')) return json({ error: 'denied' }, 403);
            if (target.pathname.endsWith('/locked')) return json({ ...stored, id: 'locked', encryptionMode: 'e2ee', header: 'broken', dataEncryptionKey: 'unopenable' });
            if (stored && target.pathname.endsWith('/recipients')) return json(recipientCensus());
            if (!stored || target.pathname !== `/v1/artifacts/${stored.id}`) return json({ error: 'missing' }, 404);
            if (init?.method === 'DELETE') { stored = undefined; return new Response(null, { status: 204 }); }
            if (init?.method !== 'POST') return json(stored);
            const update = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (update.expectedHeaderVersion !== stored.headerVersion || update.expectedBodyVersion !== stored.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            stored = { ...stored, header: update.header!, body: update.body!, provenance: update.provenance,
                ...(update.kind === undefined ? {} : artifactKindProjection(update.kind)),
                ...(update.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: update.provenanceDataEncryptionKey }),
                headerVersion: 2, bodyVersion: 2 };
            return json({ success: true, headerVersion: 2, bodyVersion: 2 });
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const workflowBody = (text: string) => JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1,
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'review', document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            } });
            const body = workflowBody('Review');
            const artifactId = '11111111-1111-4111-8111-111111111111';
            const header = { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } };
            const port = context.workflowArtifacts;
            expect(await port.read(artifactId)).toBeNull();
            await port.create({ artifactId, header, body });
            expect(stored?.id).toBe(artifactId);
            expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            const encryption = (await context.resolveAccountEncryption()).encryption;
            const key = encryption ? await encryption.decryptEncryptionKey(stored!.dataEncryptionKey) : null;
            const storedHeader = mode === 'plain' ? decodePlainArtifactStoredContent(stored!.header)
                : await new ArtifactEncryption(key!).decryptHeaderRaw(stored!.header);
            const expectedHeader = withArtifactExcerptV1({ ...header, previewSteps: ['Review'] }, body);
            expect(storedHeader).toEqual(expectedHeader);
            expect(await port.read(artifactId)).toEqual({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', publicAudience: 'none', header: expectedHeader, body,
                provenance: { savedBy: { kind: 'person', accountId: 'artifact-account' } }, revision: { headerVersion: 1, bodyVersion: 1 } });
            const page = await port.list({ limit: 1, cursor: 'incoming-cursor' });
            expect(page.items[0]).toMatchObject({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', header: expectedHeader, headerVersion: 1, updatedAt: 9 });
            expect(page.nextCursor).toBe(context.encodeArtifactListCursor(page.items[0]!));
            expect(requests.find((url) => url.searchParams.has('cursor'))?.searchParams.get('cursor')).toBe('incoming-cursor');
            expect(requests.find((url) => url.searchParams.has('limit'))?.searchParams.get('limit')).toBe('1');
            // Header-only classification does not consume private attribution.
            // Unreadable attribution must still fail a body/exact read closed.
            const validStored = stored!;
            stored = { ...validStored, provenance: 'unreadable attribution' };
            expect(await port.list({ limit: 500, includeBody: false })).toMatchObject({
                coverage: 'complete', items: [{ artifactId, header: expectedHeader }],
            });
            expect((await port.list({ limit: 500, includeBody: true })).coverage).toBe('partial');
            await expect(port.read(artifactId)).rejects.toMatchObject({ code: 'content_unavailable' });
            stored = validStored;
            const nextHeader = { ...header, revision: { headerVersion: 2, bodyVersion: 2 } };
            expect(await port.update({ artifactId, expectedRevision: header.revision, header: nextHeader, body })).toEqual({ ok: true, revision: nextHeader.revision });
            expect(await port.update({ artifactId, expectedRevision: header.revision, header: nextHeader, body: workflowBody('Overwrite') })).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            await expect(port.read('transport-error')).rejects.toMatchObject({ status: 403 });
            await expect(port.read('locked')).rejects.toMatchObject({ code: mode === 'e2ee' ? 'artifact_content_unavailable' : 'content_unavailable' });
            expect(await port.delete(artifactId)).toEqual({ ok: true });
            expect(await port.read(artifactId)).toBeNull();
        } finally { context.dispose(); }
    });
});

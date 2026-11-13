import * as React from 'react';
import axios from 'axios';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ArtifactSignedInLinkCreateRequestV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { StoredContentPublicShareCreateRequestV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PENDING_INPUT_PROTOCOL_VERSION_V5 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createUiClientActionReverseHandler } from './clientActionReverseDispatch';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { resetInMemoryAccountSettingsContextForTests } from '../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

beforeAll(loadSyncSingletonForTests);

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
const callerSessionId = 'c111111111111111111111111';
const sharedSessionId = 'c222222222222222222222222';
afterEach(async () => { await home?.dispose(); home = undefined;
    resetInMemoryAccountSettingsContextForTests();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('approved Agent document sharing delivery', () => {
    it('admits public-link create at the existing answering-client boundary', () => {
        expect(UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId: 'artifact.public_link.create',
            input: { artifactId: 'document', audience: 'anonymous' },
            context: { surface: 'agent', authority: 'account_automation',
                actionCaller: { kind: 'session', sessionId: callerSessionId, starterDepth: 0, turnDepth: 0 } } }).success).toBe(true);
    });
    it.each([
        ['template', 'cli'], ['anonymous', 'cli'], ['signed_in', 'cli'], ['no_client', 'cli'],
        ['template', 'ui'], ['anonymous', 'ui'], ['signed_in', 'ui'],
        ['anonymous', 'waived'], ['signed_in', 'waived'], ['anonymous', 'person'],
        ['session', 'waived'], ['session', 'person'],
    ] as const)('reviews and privately delivers %s via %s exactly once, or refuses without a client', async (mode, reviewer) => {
        const sessionLink = mode === 'session';
        const linkActionId = sessionLink ? 'session.public_link.create' : 'artifact.public_link.create';
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, ...(reviewer === 'waived' ? {
            approvalWaivedSurfaces: { [linkActionId]: ['agent'] },
            // Direct native exposure exercises both MCP result channels;
            // action_execute's generic contract has no structured result.
            actions: { [linkActionId]: { toolExposureModes: { agent: 'direct' } } },
        } : reviewer === 'person' ? {
            approvalWaivedSurfaces: { [linkActionId]: ['cli'] },
        } : {}) });
        const accountSettings = { actionsSettingsV1: actionsSettings };
        const features = FeaturesResponseSchema.parse(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_signed_link' },
            session: { pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V5 } },
        } }));
        const artifactLink = mode !== 'template';
        const draftId = '7e23f798-230a-42f3-931f-e38b20736333';
        const releaseId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
        const content = { v: 1 as const, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
            skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } };
        const draft = { v: 1 as const, state: 'draft' as const, sourceSessionRef: { serverId: 'home', sessionId: 'bot-session' },
            releaseArtifactId: releaseId, content, candidates: { skills: [], memoryRules: [] } };
        const sessionRow = createPlainSessionCurrentProjectionRecordFixture({ id: sharedSessionId });
        const callerSessionRow = createPlainSessionCurrentProjectionRecordFixture({ id: callerSessionId });
        const pendingInputs = new Map<string, unknown>();
        const answerLinkRequest = async (path: string, init?: RequestInit) => {
                // The App's captured Home transport also reads admission settings.
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: accountSettings } });
                if (path.split('?')[0] === `/v2/sessions/${sharedSessionId}`) return Response.json({ session: sessionRow });
                if (path.split('?')[0] === `/v2/sessions/${callerSessionId}`) return Response.json({ session: callerSessionRow });
                if (path === `/v2/sessions/${callerSessionId}/pending` && init?.method === 'POST') {
                    const input: unknown = JSON.parse(String(init.body));
                    if (!input || typeof input !== 'object' || !('localId' in input) || typeof input.localId !== 'string') {
                        throw new Error('Expected originating Session input identity');
                    }
                    const didWrite = !pendingInputs.has(input.localId);
                    pendingInputs.set(input.localId, input);
                    return Response.json({ didWrite, requestedAction: 'requestedAction' in input ? input.requestedAction : undefined,
                        pending: { localId: input.localId }, message: { localId: input.localId } });
                }
                if (path === `/v1/sessions/${sharedSessionId}/turns`) return Response.json({ error: 'not_found' }, { status: 404 });
                if (!['/v1/artifact-signed-in-links', '/v1/public-shares'].includes(path) || init?.method !== 'POST') return null;
                const raw: unknown = JSON.parse(String(init.body));
                const signed = path === '/v1/artifact-signed-in-links';
                const request = signed ? ArtifactSignedInLinkCreateRequestV1Schema.parse(raw)
                    : StoredContentPublicShareCreateRequestV1Schema.parse(raw);
                const artifactId = 'artifactId' in request ? request.artifactId : request.subject.id;
                return Response.json({ publicShare: { id: artifactId, subject: { kind: sessionLink ? 'session' : 'artifact', id: artifactId },
                    ...(signed ? { audience: 'signed_in' } : {}), expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
                    networkOff: false, keyDerivation: 'fragment_v1', createdAt: 1, updatedAt: 1 }, viewerOrigin: signed ? 'https://agent-template-share.test/ui' : 'https://agent-template-share.test',
                    ...('preserveExisting' in request && request.preserveExisting ? { created: true } : {}) });
            };
        const linkBoundary = createSessionReadBatchFetchBoundary(async (input, init) => {
            const url = new URL(String(input));
            return answerLinkRequest(`${url.pathname}${url.search}`, init);
        });
        home = await createPlainArtifactHomeFixture('https://agent-template-share.test', { currentAccount: true, serverFeatures: features,
            handleRequest: (path, init) => linkBoundary(new URL(path, 'https://agent-template-share.test'), init) });
        await setServerProfileIdentityForUrl('https://agent-template-share.test', 'srv_signed_link');
        // The Home fixture admits its active runtime before this authenticated
        // identity arrives; apply that identity as the connection owner does.
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: draftId, isDecrypted: true, title: 'Garden',
            header: artifactLink ? { kind: 'markdown' } : projectBotTemplateArtifactHeaderV1(draft), body: artifactLink ? '# Garden' : JSON.stringify(draft), access: 'owner', publicAudience: 'none',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'));
        const { Modal, ModalProvider } = await import('@/modal');
        const screen = await renderScreen(<ModalProvider />);
        try {
        const receive = createUiClientActionReverseHandler({ serverId: home.home.id, accountId: 'artifact-account', isCurrent: () => true });
        const clientResponses: unknown[] = [];
        // Only authenticated HTTP and the Session-host-to-App network hop are
        // substituted; canonical admission, placement and approval replay run.
        const dispatch = createClientActionReverseDispatcher(() => ({
            hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
            callConnectedClientRpc: async (_method, payload, options) => {
                if (mode === 'no_client') return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
                options.onIssued();
                const result = await receive(payload, { signal: options.signal ?? new AbortController().signal });
                clientResponses.push({ payload, result });
                return { ok: true, result };
            },
        }));
        const endpoint = 'https://agent-template-share.test';
        const currentness = createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0 });
        const cliHttpPaths: string[] = [];
        const answerHttp = async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            cliHttpPaths.push(path);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/profile') return Response.json({ id: 'artifact-account' });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (path === '/v1/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: accountSettings } });
            const linkResponse = await answerLinkRequest(path, init);
            if (linkResponse) return linkResponse;
            const response = await home!.boundary.handle(`${path}${new URL(url).search}`, init);
            if (!response) throw new Error(`Unexpected CLI HTTP ${init?.method ?? 'GET'} ${path}`);
            return response;
        };
        vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => answerHttp(String(input), init));
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const response = await answerHttp(String(url)); return { status: response.status, data: await response.json() };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const response = await answerHttp(String(url), { method: 'POST', body: JSON.stringify(body) });
            return { status: response.status, data: await response.json() };
        });
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const response = await answerHttp(String(config.url), { method: config.method?.toUpperCase(),
                ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }) });
            return { status: response.status, data: await response.json() };
        });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'artifact-account', provenance: {
            v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
        const { createCliActionExecutorFromCredentials } = await import('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
        const cli = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
            serverId: home.home.id, serverApiUrl: endpoint, serverIdentityId: 'srv_signed_link', clientActionExecute: dispatch,
            resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
        const [{ createCliActionExecutorHarness }, { bootstrapAccountSettingsContext }, { runWithServerHttpBaseUrl },
            { createHostApprovalOriginCurrentness }] = await Promise.all([
            import('../../../../../cli/src/session/actions/createCliActionExecutorHarness'),
            import('../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext'),
            import('../../../../../cli/src/api/client/serverHttpBaseUrl'),
            import('../../../../../cli/src/session/actions/approvals/hostOriginCurrentness'),
        ]);
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
        if (reviewer !== 'person' && artifactLink) {
            await runWithServerHttpBaseUrl(endpoint, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking' }));
        }
        // This is the production Session host's core executor (createActionExecutor),
        // including its real Account policy and approval Artifact owners. The host
        // supplies its already-bound caller; installing a daemon is outside this hop.
        const sessionHost = createCliActionExecutorHarness({ token, credentials, sessionId: callerSessionId, mode: 'plain', ctx: null,
            serverId: home.home.id, serverHttpBaseUrl: endpoint, serverIdentityId: 'srv_signed_link',
            resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) },
            { clientActionExecute: dispatch,
                isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({ credentials,
                    serverId: home.home.id, serverApiUrl: endpoint,
                    resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) }),
            });
        const agentExecutor: typeof sessionHost.executor = {
            ...sessionHost.executor,
            execute: (id, value, context) => sessionHost.executor.execute(id, value, {
                ...context, actionsSettings,
                ...(context?.surface === 'agent' ? {
                    defaultSessionId: callerSessionId,
                    actionCaller: { kind: 'session', sessionId: callerSessionId, starterDepth: 0, turnDepth: 0 },
                } : {}),
            }),
        };
        const agent = artifactLink ? agentExecutor : cli;
        const actionId = artifactLink ? linkActionId : 'template.release' as const;
        const input = sessionLink ? { sessionId: sharedSessionId, isConsentRequired: false }
            : artifactLink ? { artifactId: draftId, audience: mode === 'signed_in' ? 'signed_in' : 'anonymous' } : { draftArtifactId: draftId,
            expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
            share: { recipients: [], signedInLink: true } };
        if (reviewer === 'person') {
            const result = await cli.execute(actionId, input, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } });
            expect(result.ok, JSON.stringify({ code: result.ok ? 'success' : result.errorCode, cliHttpPaths })).toBe(true);
            expect(result.ok && 'url' in result.result && typeof result.result.url === 'string').toBe(true);
            expect(clientResponses).toHaveLength(0);
            expect(screen.getTextContent().includes('#k=')).toBe(false);
            return;
        }
        if (reviewer === 'waived') {
            const [{ McpServer }, { Client }, { InMemoryTransport }, tools, inventoryOwner, bridgeOwner] = await Promise.all([
                import('@modelcontextprotocol/sdk/server/mcp.js'), import('@modelcontextprotocol/sdk/client/index.js'),
                import('@modelcontextprotocol/sdk/inMemory.js'),
                import('../../../../../cli/src/mcp/server/registerHappierMcpBuiltInTools'),
                import('../../../../../cli/src/agent/tools/happierTools/listBuiltInHappierTools'),
                import('../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge'),
            ]);
            const bridge = bridgeOwner.createActionToolExecutorBridge({ surface: 'agent', executor: agent, actionsSettings });
            const catalog = inventoryOwner.createHappierToolInventory({ surface: 'agent', actionsSettings });
            const inventory = tools.prepareHappierMcpToolInventory({ sessionId: callerSessionId, inventory: {
                ...catalog, tools: catalog.tools.filter(tool => tool.actionId === actionId),
            } });
            const server = new McpServer({ name: 'private-sharing', version: '1' });
            tools.registerHappierMcpBuiltInTools(server, { sessionId: callerSessionId, surface: 'agent', actionsSettings,
                toolInventory: inventory, deps: { ...bridge, changeTitle: async () => ({ success: true }),
                    resolveActionOptions: args => bridge.resolveActionOptions(args, callerSessionId) } });
            const client = new Client({ name: 'sharing-agent', version: '1' });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            try {
                await server.connect(serverTransport);
                await client.connect(clientTransport);
                expect(inventory.tools).toHaveLength(1);
                const liveResult = await client.callTool({ name: inventory.tools[0]!.name, arguments: input });
                const errorCodes = Array.isArray(liveResult.content) ? liveResult.content.flatMap(item => {
                    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') return [];
                    try { const parsed: unknown = JSON.parse(item.text);
                        if (!parsed || typeof parsed !== 'object' || !('errorCode' in parsed)) return [];
                        const propertyError = 'error' in parsed && typeof parsed.error === 'string'
                            && /^Cannot read properties of (?:undefined|null) \(reading '[A-Za-z0-9_]+'\)$/u.test(parsed.error)
                            ? parsed.error : undefined;
                        const boundaryError = 'error' in parsed && typeof parsed.error === 'string'
                            && /^(?:Session request requires credentials|Unexpected CLI HTTP (?:GET|POST) \/[A-Za-z0-9_/-]+)$/u.test(parsed.error)
                            ? parsed.error : undefined;
                        return [{ code: parsed.errorCode, propertyError, boundaryError,
                            ...('failureCause' in parsed ? { failureCause: parsed.failureCause } : {}) }];
                    } catch { return []; }
                }) : [];
                const boundaryDiagnostics = clientResponses.map(response => {
                    if (!response || typeof response !== 'object' || !('result' in response)) return null;
                    return JSON.parse(JSON.stringify(response.result, (key, value) => {
                        if (value !== null && typeof value === 'object') return value;
                        return ['errorClass', 'errorCode', 'httpStatus', 'phase', 'reason'].includes(key)
                            && (typeof value === 'number' || typeof value === 'string' && /^[A-Za-z0-9_]+$/u.test(value))
                            ? value : undefined;
                    }));
                });
                expect(liveResult.isError, JSON.stringify({ errorCodes, boundaryDiagnostics,
                    requestPaths: home.requests.map(request => request.path), cliHttpPaths })).toBe(false);
                await vi.waitFor(() => expect(screen.getTextContent()).toContain('#k='));
                expect(screen.getTextContent().match(/#k=/gu)).toHaveLength(1);
                expect(liveResult.structuredContent).toMatchObject(sessionLink ? { id: sharedSessionId } : { publicShare: { id: draftId } });
                const issuedUrl = screen.getTextContent().match(/https:\/\/[^\s]+#k=[^\s]+/u)?.[0];
                expect(Boolean(issuedUrl)).toBe(true);
                for (const channel of [liveResult.content, liveResult.structuredContent]) {
                    expect(JSON.stringify(channel).includes('#k=')).toBe(false);
                    expect(JSON.stringify(channel).includes(issuedUrl ?? '')).toBe(false);
                }
                expect(Object.prototype.hasOwnProperty.call(liveResult.structuredContent, 'url')).toBe(false);
                if (Array.isArray(liveResult.content)) for (const item of liveResult.content) {
                    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') continue;
                    const rawResult: unknown = JSON.parse(item.text);
                    expect(Object.prototype.hasOwnProperty.call(rawResult, 'url')).toBe(false);
                }
                expect(clientResponses).toHaveLength(1);
                expect(home.requests.filter(request => request.path === (mode === 'signed_in' ? '/v1/artifact-signed-in-links' : '/v1/public-shares'))).toHaveLength(1);
            } finally { await client.close(); await server.close(); }
            return;
        }
        const proposed = await agent.execute(actionId, input, { surface: 'agent', authority: 'account_automation',
            ...(artifactLink ? { defaultSessionId: callerSessionId,
                actionCaller: { kind: 'session' as const, sessionId: callerSessionId, starterDepth: 0, turnDepth: 0 } }
                : { actionCaller: { kind: 'host' as const } }), actionRequestId: 'agent-template-share' });
        expect(proposed.ok, JSON.stringify({ code: proposed.ok ? 'success' : proposed.errorCode, cliHttpPaths })).toBe(true);
        expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok) throw new Error('Missing reviewed proposal');
        const approval = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
        expect(home.boundary.readPlainBody(releaseId)).toBeNull();
        const answeringExecutor = reviewer === 'ui' ? createDefaultActionExecutor() : agent;
        const result = await answeringExecutor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, {
            surface: reviewer, authority: 'present_user', actionCaller: { kind: 'host' } });
        if (mode === 'no_client') {
            expect(result).toMatchObject({ ok: true, result: { execution: { ok: false, errorCode: 'unavailable' } } });
            expect(clientResponses).toHaveLength(0);
            expect(home.requests.filter(request => request.path === '/v1/public-shares')).toHaveLength(0);
            return;
        }
        expect(result, JSON.stringify(result, (key, value) => key === 'url' ? '[private]' : value)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: artifactLink ? { status: 'public_link_created' } : { artifactId: releaseId } } } });
        const replayed = await answeringExecutor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, {
            surface: reviewer, authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(replayed).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('#k='));
        expect(screen.getTextContent().match(/#k=/gu)).toHaveLength(1);
        const issuedUrl = screen.getTextContent().match(/https:\/\/[^\s]+#k=[^\s]+/u)?.[0];
        expect(Boolean(issuedUrl?.includes('#k='))).toBe(true);
        expect(JSON.stringify(result).includes('#k=')).toBe(false);
        expect(JSON.stringify([...pendingInputs.values()]).includes('#k=')).toBe(false);
        expect(JSON.stringify(result).includes('https://agent-template-share.test')).toBe(false);
        expect(JSON.stringify(proposed).includes('#k=')).toBe(false);
        expect(clientResponses).toHaveLength(reviewer === 'ui' ? 0 : 1);
        expect(home.requests.filter(request => request.path === (mode === 'anonymous' ? '/v1/public-shares' : '/v1/artifact-signed-in-links'))).toHaveLength(1);
        expect(JSON.stringify(home.boundary.list()).includes('#k=')).toBe(false);
        expect(screen.findByTestId('document-share-signed-in-link-copy')).toBeTruthy();
        expect(Boolean(screen.findByTestId('document-share-signed-in-link'))).toBe(mode !== 'anonymous');
        } finally { Modal.hideAll(); await screen.unmount(); }
    });
});

import * as React from 'react';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ArtifactSignedInLinkCreateRequestV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { StoredContentPublicShareCreateRequestV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createUiClientActionReverseHandler } from './clientActionReverseDispatch';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('approved Agent document sharing delivery', () => {
    it('admits public-link create at the existing answering-client boundary', () => {
        expect(UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId: 'artifact.public_link.create',
            input: { artifactId: 'document', audience: 'anonymous' },
            context: { surface: 'agent', authority: 'account_automation' } }).success).toBe(true);
    });
    it.each([
        ['template', 'cli'], ['anonymous', 'cli'], ['signed_in', 'cli'], ['no_client', 'cli'],
        ['template', 'ui'], ['anonymous', 'ui'], ['signed_in', 'ui'],
    ] as const)('reviews and privately delivers %s via %s exactly once, or refuses without a client', async (mode, reviewer) => {
        const artifactLink = mode !== 'template';
        const draftId = '7e23f798-230a-42f3-931f-e38b20736333';
        const releaseId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
        const content = { v: 1 as const, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
            skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } };
        const draft = { v: 1 as const, state: 'draft' as const, sourceSessionRef: { serverId: 'home', sessionId: 'bot-session' },
            releaseArtifactId: releaseId, content, candidates: { skills: [], memoryRules: [] } };
        const answerLinkRequest = async (path: string, init?: RequestInit) => {
                // The App's captured Home transport also reads admission settings.
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
                if (!['/v1/artifact-signed-in-links', '/v1/public-shares'].includes(path) || init?.method !== 'POST') return null;
                const raw: unknown = JSON.parse(String(init.body));
                const signed = path === '/v1/artifact-signed-in-links';
                const request = signed ? ArtifactSignedInLinkCreateRequestV1Schema.parse(raw)
                    : StoredContentPublicShareCreateRequestV1Schema.parse(raw);
                const artifactId = 'artifactId' in request ? request.artifactId : request.subject.id;
                return Response.json({ publicShare: { id: artifactId, subject: { kind: 'artifact', id: artifactId },
                    ...(signed ? { audience: 'signed_in' } : {}), expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
                    networkOff: false, keyDerivation: 'fragment_v1', createdAt: 1, updatedAt: 1 }, viewerOrigin: signed ? 'https://agent-template-share.test/ui' : 'https://agent-template-share.test',
                    ...('preserveExisting' in request && request.preserveExisting ? { created: true } : {}) });
            };
        home = await createPlainArtifactHomeFixture('https://agent-template-share.test', { currentAccount: true,
            handleRequest: answerLinkRequest });
        await setServerProfileIdentityForUrl('https://agent-template-share.test', 'srv_signed_link');
        home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: draftId, isDecrypted: true, title: 'Garden',
            header: artifactLink ? { kind: 'markdown' } : projectBotTemplateArtifactHeaderV1(draft), body: artifactLink ? '# Garden' : JSON.stringify(draft), access: 'owner', publicAudience: 'none',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'));
        const { Modal, ModalProvider } = await import('@/modal');
        const screen = await renderScreen(<ModalProvider />);
        try {
        const receive = createUiClientActionReverseHandler({ serverId: home.home.id, accountId: 'artifact-account', isCurrent: () => true });
        const clientResponses: unknown[] = [];
        // Only authenticated HTTP and the daemon-to-App network hop are
        // substituted; original admission, preparation and approval replay run.
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
        const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_signed_link' } } });
        const currentness = createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0 });
        const answerHttp = async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/profile') return Response.json({ id: 'artifact-account' });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (path === '/v1/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
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
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'artifact-account', provenance: {
            v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
        const { createCliActionExecutorFromCredentials } = await import('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
        const cli = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
            serverId: home.home.id, serverApiUrl: endpoint, serverIdentityId: 'srv_signed_link', clientActionExecute: dispatch,
            resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
        const actionId = artifactLink ? 'artifact.public_link.create' as const : 'template.release' as const;
        const input = artifactLink ? { artifactId: draftId, audience: mode === 'signed_in' ? 'signed_in' : 'anonymous' } : { draftArtifactId: draftId,
            expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
            share: { recipients: [], signedInLink: true } };
        const proposed = await cli.execute(actionId, input, { surface: 'agent', authority: 'account_automation',
            actionCaller: { kind: 'host' }, actionRequestId: 'agent-template-share' });
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok) throw new Error('Missing reviewed proposal');
        const approval = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
        expect(home.boundary.readPlainBody(releaseId)).toBeNull();
        const answeringExecutor = reviewer === 'ui' ? createDefaultActionExecutor() : cli;
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

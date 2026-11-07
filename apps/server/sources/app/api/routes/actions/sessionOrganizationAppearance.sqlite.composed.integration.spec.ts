import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createActionExecutor, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { registerSessionOrganizationRoutes } from '../session/registerSessionOrganizationRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { restoreServerAccountForTest, installDisconnectedServerSocketBoundary, configureConnectedServerSocketBoundary } from '../../../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '../../../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '../../../../../../ui/sources/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '../../../../../../ui/sources/dev/testkit';
import { createClientActionReverseDispatcher } from '../../../../../../cli/src/session/actions/clientActionReverseDispatch';

vi.mock('socket.io-client', async importOriginal =>
    (await import('../../../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('../../../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('../../../../../../ui/sources/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('../../../../../../ui/sources/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('../../../../../../ui/sources/modal', async () => (await import('../../../../../../ui/sources/dev/testkit/mocks/modal')).createModalModuleMock().module);
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

describe('Agent saved personal appearance through Home routing and the client owner', () => {
    it('applies and resets both intents through real admission and Account persistence', async () => {
        const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-appearance-action-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        let restoreLoader: (() => void) | undefined;
        try {
            const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const session = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const terminalToken = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
            const homeId = await getOrCreateServerIdentityId();
            enableAuthentication(app);
            registerAccountEncryptionRoutes(app);
            registerAccountSettingsRoutes(app);
            registerSessionOrganizationRoutes(app);
            featuresRoutes(app);
            let executor: ReturnType<typeof createActionExecutor>;
            // Only the daemon/client network hop is substituted. The public router,
            // Action admission, captured Account, encryption and saved writers run real.
            registerExternalActionRoutes(app, { dispatch: async request => ({ kind: 'response',
                prepared: prepareExternalActionResponseEnvelopeV1({ v: 1, actionId: request.actionId,
                    execution: await executor.execute(ActionIdSchema.parse(request.actionId), request.envelope.v === 1 ? request.envelope.input : {}, {
                        surface: 'agent', authority: request.principal.authority, serverId: homeId,
                        defaultSessionId: 'background-agent-session',
                        actionsSettings: storage.getState().settings.actionsSettingsV1,
                    }) }),
            }) });
            await app.ready();
            await loadSyncSingletonForTests();
            restoreLoader = await installRealActionExecutorModuleLoader();
            connection = await restoreServerAccountForTest({ serverUrl: 'https://appearance-owner.example.test', serverIdentityId: homeId,
                accountId: account.id, credentials: { token }, request: async (url, init) => {
                    const parsed = new URL(String(url));
                    const result = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'PUT' | 'POST' | 'DELETE',
                        url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init?.headers)),
                        ...(init?.body ? { payload: String(init.body) } : {}) });
                    return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': 'application/json' } });
                } });
            const { storage } = await import('../../../../../../ui/sources/sync/domains/state/storage');
            storage.getState().applySettingsLocal({ actionsSettingsV1: { v: 1, actions: {
                'session.organization.appearance.set': { approvalRequiredSurfaces: [] },
                'projects.organization.color.set': { approvalRequiredSurfaces: [] },
            } } });
            const { captureActiveServerAccountScopeLifetime } = await import('../../../../../../ui/sources/sync/domains/scope/activeServerAccountScope');
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Restored Account lifetime is unavailable');
            const { createUiClientActionReverseHandler } = await import('../../../../../../ui/sources/sync/ops/actions/clientActionReverseDispatch');
            const receive = createUiClientActionReverseHandler({ serverId: connection.home.id, accountId: account.id,
                isCurrent: lifetime.isCurrent });
            const reverse = createClientActionReverseDispatcher(() => ({
                hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
                // Only Socket delivery is substituted. The CLI selects its real
                // client route, and the real UI receiver resumes the admitted intent.
                callConnectedClientRpc: async (method, payload, options) => {
                    if (method !== RPC_METHODS.UI_ACTION_EXECUTE) return { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
                    options.onIssued();
                    return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
                },
            }));
            executor = createActionExecutor({ clientActionExecute: reverse });
            const invoke = (actionId: string, input: unknown, bearer = terminalToken) => app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${bearer}` }, payload: { v: 1, requestId: crypto.randomUUID(), input } });
            const color = { kind: 'accent', key: 'blue' };
            for (const next of [color, null]) {
                for (const [actionId, input] of [
                    ['session.organization.appearance.set', { sessionId: session.id, color: next }],
                    ['projects.organization.color.set', { workspaceKey: 'personal-project', color: next }],
                ] as const) {
                    const response = await invoke(actionId, input);
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ v: 1, actionId,
                        execution: { ok: true, result: { status: 'applied' } } });
                }
                const saved = await db.sessionAppearance.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } } });
                if (next) expect(saved?.displayDbValue).toBe(JSON.stringify({ t: 'plain', v: { color: next } }));
                else expect(saved).toBeNull();
                const group = await db.sessionOrganizationLabel.findFirst({ where: { accountId: account.id, scopeKey: 'personal-project', labelKind: 'workspace' } });
                if (next) expect(group?.displayDbValue).toBe(JSON.stringify({ t: 'plain', v: { color: next } }));
                else expect(group?.archivedAt).not.toBeNull();
            }
            const invalid = await invoke('session.organization.appearance.set', { sessionId: session.id, color }, 'invalid');
            expect(invalid.statusCode).toBe(401);
            const interactive = await invoke('session.organization.appearance.set', { sessionId: session.id, color }, token);
            expect(interactive.statusCode).toBe(200);
        } finally {
            await connection?.dispose();
            await standardCleanup();
            restoreLoader?.();
            await app.close();
            await harness.close();
        }
    }, 300_000);
});

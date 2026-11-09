import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, AccountApiTokenSelfV1Schema} from '@happier-dev/protocol/auth/accountApiTokens';
import { SessionCreationKeyV1Schema} from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionDraftAddressV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc';
import type { EmbeddedNewSessionDraft } from '@/components/sessions/shell/embedded/embeddedSessionTarget';
import { createEmbedEncryption } from '@/embed/encryption/createEmbedEncryption';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';
import '@/sync/ops/actions/defaultActionExecutor';
import { createEmbedSessionRuntime } from './createEmbedSessionRuntime';
import { writeNewSessionDraft, writeSessionDraftLocalSupplement } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createEmbeddedNewChatSpawnExecutor } from '@/components/sessions/shell/embedded/EmbeddedSessionNewChat';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';

// Only Expo's native random boundary is substituted; Action and encryption
// owners remain real and use the existing cryptographic Node adapters.
vi.mock('expo-crypto', async () => ({
    ...await import('@/platform/cryptoRandom.node'),
    ...await import('@/platform/randomUUID.node'),
}));

// Load the real executor and creator during collection: cold UI module linking
// must not outlive a timed-out test and use the next case's HTTP boundary.

afterEach(() => { resetRuntimeFetch(); vi.restoreAllMocks(); vi.useRealTimers(); });

const endpointUrl = 'https://home.example';
function newChatSelf(observeCreation = false) {
    return AccountApiTokenSelfV1Schema.parse({
        accountId: 'account', accountEncryptionMode: 'plain',
        credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
        grant: { v: 1, actions: { families: [], ids: ['session.spawn_new', ...(observeCreation ? ['action.operations.get'] : [])] },
            targets: { sessions: [], machines: ['bound-machine'] }, approve: false,
            origins: ['https://allowed.example'], models: null, permissionModes: null,
            create: { machineId: 'bound-machine', agentTargetKey: 'agent:happier.agent.claude/claude',
                directory: 'managed', placement: { folderId: null, tagIds: [] } } },
        embedConfig: { v: 1, ui: { attachments: true }, newChat: { enabled: true },
            organization: { folderId: null, tagIds: [] }, style: null },
    });
}
function optionsResponse() {
    return new Response(JSON.stringify({ v: 1, actionId: 'action.options.resolve', execution: { ok: true,
        result: { actionId: 'session.spawn_new', fieldPath: 'modelSelection', optionsSourceId: null, options: [] } } }));
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
}

describe('frame credential authority', () => {
    it('changes presentation in an error state without requesting credentials, then recovers on explicit Retry', async () => {
        let selfReads = 0;
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) {
                selfReads += 1;
                return selfReads === 1 ? new Response(null, { status: 401 }) : Response.json(newChatSelf());
            }
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            throw new Error(`Unexpected request: ${path}`);
        });
        const requests: string[] = [];
        const credential = { token: 'replacement', expiresAt: new Date(Date.now() + 900_000).toISOString() };
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        runtime.attachBridge({ requestCredential: async (request) => {
            requests.push(request.reason);
            return credential;
        }, sessionCreated: () => {} });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential });
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'error' });
            runtime.configure({ ui: { attachments: false, modelPicker: false } });
            runtime.configure({ ui: { attachments: true, modelPicker: false } });
            expect(requests).toEqual([]);
            expect(selfReads).toBe(1);
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'error', ui: { attachments: true, modelPicker: false } });

            await runtime.retry();
            expect(requests).toEqual(['rejected']);
            expect(selfReads).toBe(2);
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', credential: { token: 'replacement' },
                ui: { attachments: true, modelPicker: false }, creationConfig: { attachments: true } });
        } finally { runtime.dispose(); }
    });

    it.each([
        { name: 'requester admission', execution: ActionExecuteFailureSchema.parse({ ok: false,
            errorCode: 'target_unavailable', error: 'target_unavailable', effectAttempted: false,
            details: { code: 'target_unavailable', reason: 'caller_depth_unavailable' } }) },
        { name: 'native refusal', execution: { ok: true as const, result: SessionSpawnNewResultV1Schema.parse({
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'native_agent_privileged_effect_authority_unavailable',
                message: 'Native execution authority is unavailable.' },
        }) } },
        { name: 'Provider recovery', execution: { ok: true as const, result: SessionSpawnNewResultV1Schema.parse({
            type: 'error', code: 'spawn_failed', retryable: false,
            providerError: createProviderErrorV1('provider_secret_missing'),
        }) } },
        { name: 'incompatible target', execution: { ok: true as const, result: SessionSpawnNewResultV1Schema.parse({
            type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'checkout_unavailable' },
        }) } },
    ])('preserves $name through the HTTP runtime and embedded creator to the existing presenter', async ({ name, execution }) => {
        let spawns = 0;
        let operationReads = 0;
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return Response.json(newChatSelf());
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            if (path === '/v1/actions/session.spawn_new') {
                spawns += 1;
                return Response.json({ v: 1, actionId: 'session.spawn_new', execution });
            }
            if (path === '/v1/actions/action.operations.get') operationReads += 1;
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        const onSpawned = vi.fn();
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
            } });
            const executor = createEmbeddedNewChatSpawnExecutor({ readOnCreate: () => runtime.createSession, onSpawned });
            const result = await executor({ creationKey: SessionCreationKeyV1Schema.parse(`refused-${name.replaceAll(' ', '-')}`),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' }, directory: { kind: 'managed' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            }, { surface: 'ui', actionRequestId: 'refused-creation' });
            expect(result).toEqual(execution);
            if (name === 'native refusal' && result.ok && result.result.type === 'error') {
                expect(resolveSessionSpawnNewResultFailureMessage(result.result))
                    .toContain('native_agent_privileged_effect_authority_unavailable');
            }
            expect({ spawns, operationReads }).toEqual({ spawns: 1, operationReads: 0 });
            expect(onSpawned).not.toHaveBeenCalled();
            expect(runtime.getSnapshot().phase).toBe('ready');
        } finally { runtime.dispose(); }
    });

    it('does not notify frame consumers for equivalent UI configuration', async () => {
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        let publications = 0;
        const unsubscribe = runtime.subscribe(() => { publications += 1; });
        try {
            const initial = runtime.getSnapshot();
            runtime.configure({ ui: {} });
            expect(runtime.getSnapshot()).toBe(initial);
            expect(publications).toBe(0);
            runtime.configure({ ui: { attachments: false } });
            expect(publications).toBe(1);
            const configured = runtime.getSnapshot();
            runtime.configure({ ui: { attachments: false } });
            expect(runtime.getSnapshot()).toBe(configured);
            expect(publications).toBe(1);
        } finally {
            unsubscribe();
            runtime.dispose();
        }
    });
    it('preserves an unknown creation outcome without reporting a credential failure or issuing another create', async () => {
        let spawns = 0;
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return Response.json(newChatSelf());
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            if (path === '/v1/actions/session.spawn_new') {
                spawns += 1;
                return Response.json({ v: 1, actionId: 'session.spawn_new', execution: { ok: true,
                    result: { type: 'pending', outcome: 'unknown', retryWithSameCreationKey: true } } });
            }
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
            } });
            await expect(runtime.createSession({ creationKey: SessionCreationKeyV1Schema.parse('unknown-create'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' }, directory: { kind: 'managed' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            }, { attemptId: 'unknown-create' })).rejects.toMatchObject({ code: 'session_create_pending', retryable: true });
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', credential: { token: 'child' } });
            expect(spawns).toBe(1);
        } finally { runtime.dispose(); }
    });

    it('reports credential unavailability while initial admission is still loading', async () => {
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        try {
            const draft: EmbeddedNewSessionDraft = { creationKey: SessionCreationKeyV1Schema.parse('loading'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, directory: { kind: 'managed' } };
            await expect(runtime.createSession(draft, { attemptId: 'loading' })).rejects.toThrow('credential_unavailable');
        } finally { runtime.dispose(); }
    });

    it('leaves attribution retry after a definitive creation exchange rejection without spawning again', async () => {
        let spawns = 0;
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(newChatSelf()));
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            if (path === '/v1/actions/session.spawn_new') {
                spawns += 1;
                return new Response(JSON.stringify({ v: 1, actionId: 'session.spawn_new', execution: {
                    ok: true, result: { type: 'success', disposition: 'created', sessionId: 'created',
                        executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                        organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } },
                } }));
            }
            throw new Error(`Unexpected request: ${path}`);
        });
        const requests: unknown[] = [];
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        runtime.attachBridge({ requestCredential: async (request) => {
            requests.push(request);
            throw Object.assign(new Error('credential_rejected'), { code: 'credential_rejected' });
        }, sessionCreated: () => {} });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
            } });
            const draft: EmbeddedNewSessionDraft = { creationKey: SessionCreationKeyV1Schema.parse('rejected-exchange'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, directory: { kind: 'managed' } };
            await expect(runtime.createSession(draft, { attemptId: 'rejected-exchange' })).rejects.toThrow('credential_rejected');
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'error', error: 'credential_rejected', requestedSessionId: 'created' });
            await runtime.retry();
            expect(requests).toEqual([
                expect.objectContaining({ reason: 'created', createdByTokenId: newChatSelf().credentialId }),
                expect.objectContaining({ reason: 'rejected', sessionId: 'created' }),
            ]);
            expect(requests[1]).not.toHaveProperty('createdByTokenId');
            expect(spawns).toBe(1);
        } finally { runtime.dispose(); }
    });
    it.each([true, false])('carries the admitted machine catalog without replacing connection refs (grant narrowing: %s)', async (restricted) => {
        const self = AccountApiTokenSelfV1Schema.parse({
            ...newChatSelf(), accountEncryptionMode: 'e2ee',
            parentTokenId: '00000000-0000-4000-8000-000000000002',
        });
        const agentTargetKey = self.grant.create!.agentTargetKey;
        const providerProjection = DaemonProviderModelProjectionResponseV1Schema.parse({
            status: 'success', agentTargetKey, groups: ['pc_work', 'pc_personal'].map((connectionId) => ({
                connectionId, providerName: 'Gateway', connectionName: connectionId,
                connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
                authorization: { authorized: true }, manualModelPolicy: 'catalog-only', supportsFreeformModelIds: false,
                suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent',
                rows: [{ ref: { agentTargetKey, providerConnectionId: connectionId, modelId: 'same-model' },
                    descriptor: { id: 'same-model', name: `Model from ${connectionId}` },
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                    compatibility: { result: { status: 'verified', selectedProtocol: 'openai-responses',
                        evidence: { sourceUrls: ['https://gateway.example'], verifiedAt: '2026-07-12' } },
                        compatibilityFingerprint: `compatibility:v1:${connectionId}`, confirmed: true },
                    endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible' }],
            })),
        });
        if (providerProjection.status !== 'success') throw new Error('invalid fixture');
        self.grant.models = restricted ? [providerProjection.groups[0]!.rows[0]!.ref] : null;
        const modelCatalog = { nativeModels: [{ value: 'same-model', label: 'Native model' }], providerProjection };
        const paths: string[] = [];
        let optionsInput: unknown;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(self));
            if (path === '/v1/actions/action.options.resolve') {
                optionsInput = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({
                v: 1, actionId: 'action.options.resolve', execution: { ok: true, result: {
                    actionId: 'session.spawn_new', fieldPath: 'modelSelection', optionsSourceId: 'agents.models.available',
                    options: [{ value: 'same-model', label: 'Native model' }], modelCatalog,
                } },
                }));
            }
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
            } });
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', creationConfig: {
                machineId: 'bound-machine', agentTargetKey, allowedModels: self.grant.models, modelCatalog,
            } });
            expect(paths).toEqual([ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, '/v1/actions/action.options.resolve']);
            expect(optionsInput).toMatchObject({ target: { kind: 'machine', machineId: 'bound-machine' }, input: {
                draftInput: { executionTarget: { machineId: 'bound-machine' } },
            } });
        } finally { runtime.dispose(); }
    });

    it('does not publish a host-bound creation profile when machine option discovery is unavailable', async () => {
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return Response.json(newChatSelf());
            if (path === '/v1/actions/action.options.resolve') return Response.json({
                v: 1,
                actionId: 'action.options.resolve',
                execution: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' },
            });
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
            } });
            expect(runtime.getSnapshot()).toMatchObject({
                phase: 'error',
                error: 'credential_unavailable',
                creationConfig: null,
            });
        } finally { runtime.dispose(); }
    });

    it('does not retire the admitted request scope while the host is providing a replacement', async () => {
        let admittedSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (url, init) => {
            if (new URL(String(url)).pathname === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(newChatSelf()));
            admittedSignal = init?.signal;
            return optionsResponse();
        });
        const replacement = deferred<{ token: string; expiresAt: string }>();
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        const expiresAt = new Date(Date.now() + 900_000).toISOString();
        runtime.attachBridge({ requestCredential: () => replacement.promise, sessionCreated: () => {} });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: { token: 'old', expiresAt } });
            const draftId = runtime.getSnapshot().creationConfig?.draftId;
            expect(SessionDraftAddressV2Schema.safeParse({ kind: 'newSession', draftId }).success).toBe(true);
            const oldSignal = admittedSignal;
            const renewed = runtime.retry();
            expect(oldSignal?.aborted).toBe(false);
            expect(runtime.getSnapshot()).toMatchObject({ credential: { token: 'old' }, reconnecting: true });
            await expect(runtime.createSession({ creationKey: SessionCreationKeyV1Schema.parse('renewing'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                directory: { kind: 'managed' } }, { attemptId: 'renewing' })).rejects.toThrow('credential_unavailable');
            replacement.resolve({ token: 'fresh', expiresAt });
            await renewed;
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', credential: { token: 'fresh' }, reconnecting: false });
            expect(runtime.getSnapshot().creationConfig?.draftId).toBe(draftId);
            await runtime.open(null);
            expect(SessionDraftAddressV2Schema.safeParse({
                kind: 'newSession', draftId: runtime.getSnapshot().creationConfig?.draftId,
            }).success).toBe(true);
            expect(runtime.getSnapshot().creationConfig?.draftId).not.toBe(draftId);
            runtime.attachBridge({ requestCredential: async () => { throw new Error('credential_unavailable'); }, sessionCreated: () => {} });
            await runtime.retry();
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'error', reconnecting: true });
            await expect(runtime.createSession({ creationKey: SessionCreationKeyV1Schema.parse('after-failed-renewal'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                directory: { kind: 'managed' } }, { attemptId: 'after-failed-renewal' })).rejects.toThrow('credential_unavailable');
        } finally { runtime.dispose(); }
    });
    it('keeps short-lived credentials admitted until a future refresh', async () => {
        const encryption = await createEmbedEncryption();
        vi.useFakeTimers();
        setRuntimeFetch(async (url) => new URL(String(url)).pathname === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1
            ? new Response(JSON.stringify(newChatSelf())) : optionsResponse());
        const requests: string[] = [];
        const runtime = createEmbedSessionRuntime({ encryption, endpointUrl });
        runtime.attachBridge({ requestCredential: (request) => { requests.push(request.reason); return new Promise(() => {}); }, sessionCreated: () => {} });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 30_000).toISOString(),
            } });
            await vi.advanceTimersByTimeAsync(1);
            expect(requests).toEqual([]);
            await vi.advanceTimersByTimeAsync(14_999);
            expect(requests).toEqual(['expiring']);
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', credential: { token: 'child' } });
        } finally { runtime.dispose(); }
    });

    it('preserves the creation presentation and attribution when the first credential exchange fails', async () => {
        let spawns = 0;
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(newChatSelf()));
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            if (path === '/v1/actions/session.spawn_new') { spawns += 1; return new Response(JSON.stringify({ v: 1, actionId: 'session.spawn_new', execution: {
                ok: true, result: { type: 'success', disposition: 'created', sessionId: 'created',
                    executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                    organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } },
            } })); }
            throw new Error(`Unexpected request: ${path}`);
        });
        const requests: unknown[] = [];
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        const created: string[] = [];
        runtime.attachBridge({ requestCredential: async (request) => { requests.push(request); throw new Error('credential_unavailable'); }, sessionCreated: (sessionId) => { created.push(sessionId); } });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: { token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString() } });
            const config = runtime.getSnapshot().creationConfig;
            const draft: EmbeddedNewSessionDraft = { creationKey: SessionCreationKeyV1Schema.parse('intent'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, directory: { kind: 'managed' } };
            const completions = await Promise.allSettled([
                runtime.createSession(draft, { attemptId: 'intent' }),
                runtime.createSession(draft, { attemptId: 'intent' }),
            ]);
            expect(completions.every((result) => result.status === 'rejected')).toBe(true);
            expect({ spawns, created }).toEqual({ spawns: 1, created: ['created'] });
            expect(runtime.getSnapshot()).toMatchObject({ presentationTargetKind: 'new', presentationTargetKey: 0,
                creationConfig: config, credential: { token: 'child' }, requestedSessionId: 'created' });
            await expect(runtime.createSession(draft, { attemptId: 'intent' })).rejects.toThrow('credential_unavailable');
            expect({ spawns, created }).toEqual({ spawns: 1, created: ['created'] });
            expect(requests).toEqual([expect.objectContaining({ reason: 'created', createdByTokenId: newChatSelf().credentialId }),
                expect.objectContaining({ reason: 'created', createdByTokenId: newChatSelf().credentialId })]);
        } finally { runtime.dispose(); }
    });
    it('makes origin refusal terminal for authenticated work in the pinned frame load', async () => {
        const paths: string[] = [];
        setRuntimeFetch(async (url) => {
            paths.push(new URL(String(url)).pathname);
            return new Response(JSON.stringify({ accountId: 'account', accountEncryptionMode: 'plain',
                credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
                grant: { v: 1, actions: null, targets: null, approve: false, origins: ['https://allowed.example'],
                    models: null, permissionModes: null, create: null }, embedConfig: null }));
        });
        const credential = { token: 'child', expiresAt: '2100-01-01T00:00:00.000Z' };
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl: 'https://home.example' });
        let requests = 0;
        runtime.attachBridge({ requestCredential: async () => { requests += 1; return credential; }, sessionCreated: () => {} });
        await runtime.initialize({ parentOrigin: 'https://refused.example', credential });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'error', error: 'origin_not_allowed', credential: null });
        runtime.configure({ ui: {} });
        await runtime.retry();
        await runtime.open('another-session');
        expect(paths).toEqual([ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1]);
        expect(requests).toBe(0);
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'error', error: 'origin_not_allowed', credential: null });
        runtime.dispose();
    });

    it('refreshes at the absolute expiry deadline even when it exceeds the platform timer range', async () => {
        const encryption = await createEmbedEncryption();
        let now = Date.parse('2026-09-30T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const scheduled: { delay: number; callback: () => void; handle: ReturnType<typeof setTimeout> }[] = [];
        // Observe only long authority timers; real module/network initialization timers still run.
        const platformSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
            if (timeout === undefined || timeout <= 60_000) return platformSetTimeout(handler, timeout, ...args);
            const handle = platformSetTimeout(() => {}, 2_147_483_647);
            scheduled.push({ delay: timeout, callback: () => handler(...args), handle });
            return handle;
        });
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(newChatSelf()));
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption, endpointUrl });
        const requests: string[] = [];
        runtime.attachBridge({ requestCredential: (request) => {
            requests.push(request.reason);
            return new Promise(() => {});
        }, sessionCreated: () => {} });
        try {
            const lifetime = 30 * 24 * 60 * 60 * 1000;
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + lifetime).toISOString(),
            } });
            expect(runtime.getSnapshot().phase).toBe('ready');
            expect(scheduled).toHaveLength(1);
            expect(scheduled[0].delay).toBeLessThanOrEqual(2_147_483_647);
            now += scheduled[0].delay;
            clearTimeout(scheduled[0].handle);
            scheduled[0].callback();
            expect(requests).toEqual([]);
            expect(scheduled).toHaveLength(2);
            expect(scheduled[1].delay).toBe(lifetime - 60_000 - scheduled[0].delay);
            now += scheduled[1].delay;
            clearTimeout(scheduled[1].handle);
            scheduled[1].callback();
            expect(requests).toEqual(['expiring']);
        } finally {
            runtime.dispose();
            for (const entry of scheduled) clearTimeout(entry.handle);
        }
    });

    it('keeps a fresh same-target credential when a retired admission completes late', async () => {
        const oldOptions = deferred<Response>();
        const oldOptionsDispatched = deferred<void>();
        let optionsRequests = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) {
                const fresh = new Headers(init?.headers).get('authorization') === 'Bearer fresh-child';
                return new Response(JSON.stringify({ ...newChatSelf(), credentialId: fresh
                    ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001' }));
            }
            if (path === '/v1/actions/action.options.resolve') {
                optionsRequests += 1;
                if (optionsRequests === 1) {
                    oldOptionsDispatched.resolve();
                    // An already-produced network response can arrive despite cancellation.
                    return oldOptions.promise;
                }
                return optionsResponse();
            }
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        const expiresAt = new Date(Date.now() + 900_000).toISOString();
        runtime.attachBridge({ requestCredential: async () => ({ token: 'fresh-child', expiresAt }), sessionCreated: () => {} });
        const initialized = runtime.initialize({ parentOrigin: 'https://allowed.example', credential: { token: 'old-child', expiresAt } });
        try {
            await oldOptionsDispatched.promise;
            await runtime.retry();
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', credential: { token: 'fresh-child' } });
            oldOptions.resolve(optionsResponse());
            await initialized;
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'ready', error: undefined,
                credential: { token: 'fresh-child' }, self: { credentialId: '00000000-0000-4000-8000-000000000002' } });
        } finally {
            oldOptions.resolve(optionsResponse());
            runtime.dispose();
            await initialized;
        }
    });

    it('reattaches a reloaded frame to the retained draft attempt and observes its terminal operation', async () => {
        const success = { type: 'success', disposition: 'created', sessionId: 'recovered-session',
            executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
            organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } as const;
        let spawns = 0;
        let observations = 0;
        let initialFrame = true;
        const initialSpawnDispatched = deferred<void>();
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return Response.json(newChatSelf(true));
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            if (path === '/v1/actions/session.spawn_new') {
                spawns += 1;
                expect(JSON.parse(String(init?.body))).toMatchObject({ input: { creationKey: 'reload-attempt' } });
                if (initialFrame) {
                    initialSpawnDispatched.resolve();
                    return new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    });
                }
                return Response.json({ v: 1, actionId: 'session.spawn_new', execution: { ok: true, result: {
                    type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                    operation: { serverId: endpointUrl, machineId: 'bound-machine', operationId: 'reload-operation' },
                } } });
            }
            if (path === '/v1/actions/action.operations.get') {
                observations += 1;
                return Response.json({ v: 1, actionId: 'action.operations.get', execution: { ok: true, result: {
                    kind: 'found', operation: { version: 1, operationId: 'reload-operation', revision: 3,
                        actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: 'account', machineId: 'bound-machine' },
                        title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: success },
                } } });
            }
            throw new Error(`Unexpected request: ${path}`);
        });
        const credential = { token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString() };
        const first = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        let second: ReturnType<typeof createEmbedSessionRuntime> | null = null;
        let scope: { serverId: string; accountId: string } | null = null;
        let draftId: string | null = null;
        try {
            await first.initialize({ parentOrigin: 'https://allowed.example', credential });
            const creation = first.getSnapshot().creationConfig;
            if (!creation) throw new Error('Missing initial creation configuration');
            const recoveredScope = creation.draftScope;
            if (!recoveredScope) throw new Error('Missing initial creation draft scope');
            const recoveredDraftId = creation.draftId;
            scope = recoveredScope;
            draftId = recoveredDraftId;
            writeNewSessionDraft({ scope: recoveredScope, draftId: recoveredDraftId,
                patch: { text: 'Preserved first turn' }, materializationIntent: 'userEdit' });
            writeSessionDraftLocalSupplement({ scope: recoveredScope, address: { kind: 'newSession', draftId: recoveredDraftId },
                patch: { launchUserAttemptId: 'reload-attempt' } });
            const interrupted = first.createSession({ creationKey: SessionCreationKeyV1Schema.parse('reload-attempt'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                directory: { kind: 'managed' },
            }, { attemptId: 'reload-attempt' });
            await initialSpawnDispatched.promise;
            first.dispose();
            await expect(interrupted).rejects.toThrow();
            initialFrame = false;

            second = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
            const created: string[] = [];
            second.attachBridge({ requestCredential: async () => { throw new Error('credential_unavailable'); },
                sessionCreated: (sessionId) => { created.push(sessionId); } });
            await second.initialize({ parentOrigin: 'https://allowed.example', credential });
            expect(second.getSnapshot().creationConfig?.draftId).toBe(draftId);
            await expect(second.createSession({ creationKey: SessionCreationKeyV1Schema.parse('reload-attempt'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                directory: { kind: 'managed' },
            }, { attemptId: 'reload-attempt' })).rejects.toThrow('credential_unavailable');
            expect({ spawns, observations, created }).toEqual({ spawns: 2, observations: 1, created: ['recovered-session'] });
        } finally {
            first.dispose();
            second?.dispose();
            if (scope && draftId) writeSessionDraftLocalSupplement({ scope,
                address: { kind: 'newSession', draftId }, patch: { launchUserAttemptId: null } });
        }
    });

    it.each([
        ['open', 'success'], ['dispose', 'success'], ['open', 'pending'], ['dispose', 'pending'],
    ] as const)('settles a dispatched spawn only for the surviving frame after %s (%s receipt)', async (transition, receipt) => {
        const dispatched = deferred<void>();
        const spawnResponse = deferred<Response>();
        let spawns = 0;
        let observations = 0;
        const success = { type: 'success', disposition: 'created', sessionId: 'session-new',
            executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
            organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1) return new Response(JSON.stringify(newChatSelf(receipt === 'pending')));
            if (path === '/v1/actions/action.options.resolve') return optionsResponse();
            if (path === '/v1/actions/session.spawn_new') {
                spawns += 1;
                dispatched.resolve();
                // The network boundary honors cancellation, just as fetch does.
                return new Promise<Response>((resolve, reject) => {
                    const aborted = () => reject(new DOMException('Aborted', 'AbortError'));
                    if (init?.signal?.aborted) { aborted(); return; }
                    init?.signal?.addEventListener('abort', aborted, { once: true });
                    void spawnResponse.promise.then(resolve);
                });
            }
            if (path === '/v1/actions/action.operations.get') {
                observations += 1;
                expect(JSON.parse(String(init?.body))).toMatchObject({ input: {
                    serverId: endpointUrl, machineId: 'bound-machine', operationId: 'embed-spawn', waitForTerminal: true,
                } });
                return Response.json({ v: 1, actionId: 'action.operations.get', execution: { ok: true, result: {
                    kind: 'found', operation: { version: 1, operationId: 'embed-spawn', revision: 3,
                        actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: 'account', machineId: 'bound-machine' },
                        title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: success },
                } } });
            }
            throw new Error(`Unexpected request: ${path}`);
        });
        const runtime = createEmbedSessionRuntime({ encryption: await createEmbedEncryption(), endpointUrl });
        const requests: { sessionId?: string; reason: string }[] = [];
        const created: string[] = [];
        runtime.attachBridge({ requestCredential: (request) => {
            requests.push(request);
            return new Promise(() => {});
        }, sessionCreated: (sessionId) => { created.push(sessionId); } });
        try {
            await runtime.initialize({ parentOrigin: 'https://allowed.example', credential: {
                token: 'child', expiresAt: new Date(Date.now() + 900_000).toISOString(),
            } });
            expect(runtime.getSnapshot().phase).toBe('ready');
            const draft: EmbeddedNewSessionDraft = {
                creationKey: SessionCreationKeyV1Schema.parse('draft-attempt'),
                executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                directory: { kind: 'managed' },
            };
            const settled = runtime.createSession(draft, { attemptId: 'spawn-attempt' }).then(
                (result) => ({ ok: true, result }), (error: unknown) => ({ ok: false, error }));
            await dispatched.promise;
            if (transition === 'open') void runtime.open('session-x');
            else runtime.dispose();
            spawnResponse.resolve(new Response(JSON.stringify({ v: 1, actionId: 'session.spawn_new', execution: {
                ok: true, result: receipt === 'success' ? success : { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                    operation: { serverId: endpointUrl, machineId: 'bound-machine', operationId: 'embed-spawn' } },
            } })));
            if (transition === 'open') {
                expect(await settled).toEqual({ ok: true, result: { sessionId: 'session-new' } });
                expect(created).toEqual(['session-new']);
                expect(requests).toEqual([expect.objectContaining({ sessionId: 'session-x', reason: 'open' })]);
                expect(runtime.getSnapshot()).toMatchObject({ requestedSessionId: 'session-x', displayedSessionId: null });
                expect(observations).toBe(receipt === 'pending' ? 1 : 0);
            } else {
                expect(await settled).toMatchObject({ ok: false });
                expect(created).toEqual([]);
                expect(requests).toEqual([]);
                expect(runtime.getSnapshot()).toMatchObject({ displayedSessionId: null, credential: null });
                expect(observations).toBe(0);
            }
            expect(spawns).toBe(1);
        } finally { runtime.dispose(); }
    });
});

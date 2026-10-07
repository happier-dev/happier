import {
    type AccountApiTokenSelfV1, type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import {
    EmbedCredentialV1Schema, EmbedErrorCodeV1Schema, EmbedUiOverridesV1Schema,
    type EmbedCredentialV1, type EmbedCredentialRequestV1, type EmbedErrorCodeV1,
    type ComposerOptionsInputV1, type EmbedUiOverridesV1,
} from '@happier-dev/protocol/embed';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { EmbeddedNewSessionDraft, EmbeddedSessionNewChatCreation } from '@/components/sessions/shell/embedded/embeddedSessionTarget';
import type { EmbedEncryption } from '@/embed/encryption/createEmbedEncryption';
import { admitEmbedCredential } from '@/embed/credential/admitEmbedCredential';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { randomUUID } from '@/platform/randomUUID';
import { buildEmbedSessionSpawnInput } from './buildEmbedSessionSpawnInput';

// Browser/Node timers represent delays as signed 32-bit milliseconds, not credential TTLs.
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export type EmbedSessionRuntimeSnapshot = Readonly<{
    phase: 'loading' | 'ready' | 'error';
    requestedSessionId: string | null;
    displayedSessionId: string | null;
    presentationTargetKind: 'new' | 'session';
    presentationTargetKey: number;
    creationConfig: EmbeddedSessionNewChatCreation | null;
    creationModels: readonly ProviderBoundModelRef[] | null;
    self: AccountApiTokenSelfV1 | null;
    credential: AuthCredentials | null;
    reconnecting: boolean;
    ui: EmbedUiOverridesV1;
    error?: EmbedErrorCodeV1;
}>;
export type EmbedRuntimeBridge = Readonly<{
    requestCredential: (request: EmbedCredentialRequestV1) => Promise<EmbedCredentialV1>;
    sessionCreated: (sessionId: string) => void;
}>;

/** Frame authority: one current target and one in-memory credential, never an Account login. */
export function createEmbedSessionRuntime(input: Readonly<{
    encryption: EmbedEncryption;
    endpointUrl: string;
    navigate?: (sessionId: string | null) => void;
}>) {
    type Intent = { sessionId: string | null; key: number; draftId?: string; createdByTokenId?: string };
    type Scope = { intent: Intent; controller: AbortController; request: ServerFetch; self: AccountApiTokenSelfV1; token: string };
    let snapshot: EmbedSessionRuntimeSnapshot = {
        phase: 'loading', requestedSessionId: null, displayedSessionId: null,
        presentationTargetKind: 'new', presentationTargetKey: 0, creationConfig: null,
        creationModels: null, self: null, credential: null, reconnecting: false, ui: {},
    };
    const listeners = new Set<() => void>();
    let intent: Intent = { sessionId: null, key: 0 };
    let scope: Scope | null = null;
    let syncOwner: typeof import('@/sync/sync')['sync'] | null = null;
    let bridge: EmbedRuntimeBridge | null = null;
    let parentOrigin: string | null = null;
    let ancestors: readonly string[] = [];
    let disposed = false;
    let originRefused = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingCredential: Promise<void> | null = null;
    const creationControllers = new Set<AbortController>();
    let creation: { intent: Intent; attemptId: string; promise: Promise<{ sessionId: string }>; sessionId?: string; tokenId: string } | null = null;
    const publish = (next: EmbedSessionRuntimeSnapshot) => {
        if (disposed) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const current = (target: Intent) => !disposed && !originRefused && intent === target;
    const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const retire = (retain: boolean) => {
        clearTimer();
        scope?.controller.abort('embed-authority-retired');
        scope = null;
        syncOwner?.disposeEmbedSession({ preserveSessionState: retain });
    };
    const fail = (target: Intent, error: unknown, retain: boolean) => {
        if (!current(target)) return;
        const coded = EmbedErrorCodeV1Schema.safeParse(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined);
        const detail = error instanceof Error ? error.message : error;
        const parsed = coded.success ? coded : EmbedErrorCodeV1Schema.safeParse(
            detail === 'not_found' || detail === 'forbidden' ? 'session_not_found' : detail);
        if (parsed.success && parsed.data === 'origin_not_allowed') originRefused = true;
        const preserveSession = retain && !originRefused && (!parsed.success || parsed.data === 'credential_unavailable');
        retire(preserveSession);
        publish({ ...snapshot, phase: 'error', reconnecting: preserveSession, error: parsed.success ? parsed.data : 'credential_unavailable',
            ...(preserveSession ? {} : { credential: null, self: null, displayedSessionId: null }) });
    };
    const createCredentialRequest = (token: string, controller: AbortController, isCurrent: () => boolean,
        refreshOnRejection: () => boolean): ServerFetch => {
        const requestAtEndpoint = createServerFetchAtEndpoint({ endpointUrl: input.endpointUrl,
            credentials: { token }, signal: controller.signal,
            recoverStoredCredentials: false, superviseReachability: false, isCurrent,
        });
        return async (path, init, options) => {
            const response = await requestAtEndpoint(path, init, options);
            if (response.status === 401 && refreshOnRejection()) void requestCredential('rejected');
            return response;
        };
    };
    const admit = async (target: Intent, raw: EmbedCredentialV1, retain: boolean) => {
        if (originRefused || !parentOrigin || !current(target)) return;
        const credential = EmbedCredentialV1Schema.parse(raw);
        const controller = new AbortController();
        let admittedScope: Scope | null = null;
        const request = createCredentialRequest(credential.token, controller,
            () => current(target) && !controller.signal.aborted,
            () => admittedScope !== null && scope === admittedScope);
        try {
            // This is the sole authenticated request before origin admission.
            const self = await admitEmbedCredential({ request, parentOrigin, ancestorOrigins: ancestors });
            if (!current(target)) { controller.abort(); return; }
            const expiry = Math.min(Date.parse(credential.expiresAt), self.expiresAt === null ? Infinity : Date.parse(self.expiresAt));
            if (expiry <= Date.now()) throw new Error('credential_rejected');
            let composerOptionsInput: ComposerOptionsInputV1 | null = null;
            if (credential.sessionOptions !== undefined && target.sessionId !== null) {
                const opened = input.encryption.openSessionOptions(target.sessionId, credential.sessionOptions);
                if (!opened.ok) throw new Error('session_key_invalid');
                composerOptionsInput = opened.composerOptionsInput;
            }
            if (self.accountEncryptionMode === 'plain' && (credential.sessionKey !== undefined || credential.sessionOptions !== undefined)) {
                throw new Error('credential_rejected');
            }
            admittedScope = { intent: target, controller, request, self, token: credential.token };
            // Keep the incumbent live while the host responds and origin/key admission runs.
            // Only a validated replacement may retire its requests; sync.create owns socket swap.
            clearTimer();
            scope?.controller.abort('embed-authority-replaced');
            scope = admittedScope;
            let creationModels: readonly ProviderBoundModelRef[] | null = snapshot.creationModels;
            let creationConfig = snapshot.creationConfig;
            if (target.sessionId === null) {
                const binding = self.grant.create;
                if (!binding || self.embedConfig?.newChat?.enabled !== true) throw new Error('create_not_granted');
                const { parseBackendTargetKeyV2 } = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
                const agentTarget = parseBackendTargetKeyV2(binding.agentTargetKey);
                if (!agentTarget || agentTarget.kind !== 'agent') throw new Error('create_not_granted');
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const executor = createDefaultActionExecutor({ apiTokenAction: { request, target: { kind: 'machine', machineId: binding.machineId } } });
                const resolved = await executor.execute('action.options.resolve', {
                    actionId: 'session.spawn_new', fieldPath: 'modelSelection',
                    draftInput: { agentTarget, executionTarget: { machineId: binding.machineId } },
                }, { surface: 'ui', serverId: input.endpointUrl, signal: controller.signal });
                if (!current(target) || scope !== admittedScope) { controller.abort(); return; }
                if (!resolved.ok) throw new Error('credential_unavailable');
                // The owning Action supplies the catalog; the grant narrows it but cannot create
                // a model row or turn a Provider-bound reference into a native one.
                const { PUBLIC_ACTION_OUTPUT_SCHEMAS } = await import('@happier-dev/protocol/actions/actionSpecs');
                const catalog = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(resolved.result);
                const nativeModels = catalog.modelCatalog?.nativeModels ?? catalog.options.flatMap((option) =>
                    typeof option.value === 'string' && !option.disabled ? [{
                        value: option.value, label: option.label, description: option.description,
                    }] : []);
                const modelCatalog = {
                    nativeModels: nativeModels.map((option) => ({ ...option, description: option.description ?? '' })),
                    providerProjection: catalog.modelCatalog?.providerProjection ?? null,
                };
                creationModels = self.grant.models;
                // The canonical draft address requires a UUID. Allocate it once on the
                // existing intent so remounts and credential replacement keep the draft.
                target.draftId ??= randomUUID();
                creationConfig = { draftId: target.draftId,
                    draftScope: { serverId: input.endpointUrl, accountId: self.accountId },
                    machineId: binding.machineId, agentTargetKey: binding.agentTargetKey, allowedModels: creationModels,
                    modelCatalog,
                    permissionModes: self.grant.permissionModes, attachments: self.embedConfig?.ui.attachments !== false && snapshot.ui.attachments !== false };
            } else {
                syncOwner ??= (await import('@/sync/sync')).sync;
                if (!current(target) || scope !== admittedScope) { controller.abort(); return; }
                await syncOwner.create({ token: credential.token }, input.encryption.encryption, undefined, {
                    scope: { kind: 'embedSession', sessionId: target.sessionId }, endpointUrl: input.endpointUrl,
                    accountId: self.accountId, accountMode: self.accountEncryptionMode,
                    sessionKey: credential.sessionKey ?? null, composerOptionsInput,
                    isCurrent: () => current(target) && scope === admittedScope && !controller.signal.aborted,
                    onCredentialRejected: () => { void requestCredential('rejected'); },
                });
            }
            if (!current(target) || scope !== admittedScope) { controller.abort(); return; }
            if (expiry <= Date.now()) throw new Error('credential_rejected');
            // Attribution is one-shot only after the actual Session credential has hydrated.
            // A failed exchange keeps it for Retry; subsequent renewal uses host ownership.
            if (target.sessionId !== null) delete target.createdByTokenId;
            publish({ ...snapshot, phase: 'ready', reconnecting: false, error: undefined, requestedSessionId: target.sessionId,
                displayedSessionId: target.sessionId, self, credential: { token: credential.token }, creationModels, creationConfig });
            const refreshAt = expiry - Math.min(60_000, (expiry - Date.now()) / 2);
            const scheduleRefresh = () => {
                timer = setTimeout(() => {
                    if (!current(target) || scope !== admittedScope) return;
                    timer = null;
                    if (Date.now() < refreshAt) scheduleRefresh();
                    else void requestCredential('expiring');
                }, Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(0, refreshAt - Date.now())));
            };
            scheduleRefresh();
        } catch (error) {
            // A retired admission must not clear the replacement credential for the same target.
            if (controller.signal.aborted || (admittedScope !== null && scope !== admittedScope)) return;
            controller.abort('embed-admission-failed');
            fail(target, error, retain);
        }
    };
    function requestCredential(reason: EmbedCredentialRequestV1['reason']): Promise<void> {
        if (disposed || originRefused || !parentOrigin || !bridge) return Promise.resolve();
        if (pendingCredential) return pendingCredential;
        const target = intent;
        const retain = (snapshot.displayedSessionId !== null && snapshot.displayedSessionId === target.sessionId)
            || (snapshot.presentationTargetKind === 'new' && snapshot.creationConfig !== null && snapshot.credential !== null);
        clearTimer();
        if (reason === 'rejected') publish({ ...snapshot, phase: 'error', reconnecting: true, error: 'credential_unavailable' });
        const work = (async () => {
            try {
                const credential = await bridge!.requestCredential({ kind: 'credential.request', embedPublicKey: input.encryption.embedPublicKey,
                    ...(target.sessionId === null ? {} : { sessionId: target.sessionId }),
                    reason: target.createdByTokenId ? 'created' : reason,
                    ...(target.createdByTokenId ? { createdByTokenId: target.createdByTokenId } : {}),
                });
                if (current(target)) await admit(target, credential, retain);
            } catch (error) {
                if (current(target) && target.createdByTokenId && error !== null && typeof error === 'object'
                    && 'code' in error && error.code === 'credential_rejected') {
                    // A settled refusal (for example an expired creator or edited grant)
                    // cannot be retried as an attribution exchange. Keep the known Session
                    // target; subsequent Retry uses the host's normal ownership check.
                    delete target.createdByTokenId;
                }
                fail(target, error, retain);
            }
        })();
        pendingCredential = work;
        void work.finally(() => { if (pendingCredential === work) pendingCredential = null; });
        return work;
    }
    return {
        endpointUrl: input.endpointUrl,
        embedPublicKey: input.encryption.embedPublicKey,
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        attachBridge(value: EmbedRuntimeBridge) {
            bridge = value;
            return () => { if (bridge === value) bridge = null; };
        },
        async initialize(value: Readonly<{ parentOrigin: string; credential: EmbedCredentialV1; sessionId?: string; ui?: EmbedUiOverridesV1; ancestorOrigins?: readonly string[] }>) {
            if (disposed || parentOrigin !== null) return;
            parentOrigin = value.parentOrigin;
            ancestors = value.ancestorOrigins ?? (typeof window === 'undefined' ? [] : Array.from(window.location.ancestorOrigins ?? []));
            intent = { sessionId: value.sessionId ?? null, key: 0 };
            publish({ ...snapshot, requestedSessionId: intent.sessionId, presentationTargetKind: intent.sessionId === null ? 'new' : 'session', ui: EmbedUiOverridesV1Schema.parse(value.ui ?? {}) });
            await admit(intent, value.credential, false);
        },
        configure(value: Readonly<{ ui?: EmbedUiOverridesV1 }>) {
            const ui = EmbedUiOverridesV1Schema.parse(value.ui ?? {});
            publish({ ...snapshot, ui, creationConfig: snapshot.creationConfig ? { ...snapshot.creationConfig,
                attachments: snapshot.self?.embedConfig?.ui.attachments !== false && ui.attachments !== false } : null });
            if (snapshot.phase === 'error') void requestCredential('open');
        },
        async open(sessionId: string | null) {
            if (disposed || originRefused) return;
            retire(false);
            pendingCredential = null;
            creation = null;
            intent = { sessionId, key: intent.key + 1 };
            publish({ ...snapshot, phase: 'loading', reconnecting: false, error: undefined, requestedSessionId: sessionId, displayedSessionId: null,
                presentationTargetKind: sessionId === null ? 'new' : 'session', presentationTargetKey: intent.key,
                credential: null, self: null, creationModels: null, creationConfig: null });
            input.navigate?.(sessionId);
            await requestCredential('open');
        },
        retry: () => requestCredential('rejected'),
        async createSession(draft: EmbeddedNewSessionDraft, attempt: Readonly<{ attemptId: string }>): Promise<{ sessionId: string }> {
            if (!scope || intent.sessionId !== null || snapshot.phase !== 'ready') {
                // After a known spawn, Retry resumes only credential admission, never spawning again.
                if (creation?.sessionId && creation.intent === intent && creation.attemptId === attempt.attemptId) {
                    await requestCredential('created');
                    if (snapshot.phase !== 'ready') throw new Error(snapshot.error ?? 'credential_unavailable');
                    return { sessionId: creation.sessionId };
                }
                if (intent.sessionId === null) throw new Error(snapshot.error ?? 'credential_unavailable');
                throw new Error('create_not_granted');
            }
            if (creation && creation.intent === intent && creation.attemptId === attempt.attemptId) return creation.promise;
            const target = intent;
            const admitted = scope;
            const payload = buildEmbedSessionSpawnInput({ draft, attemptId: attempt.attemptId, self: admitted.self, endpointUrl: input.endpointUrl });
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!current(target) || scope !== admitted) throw new Error('credential_unavailable');
            // A dispatched creation reports an authoritative fact even after viewer navigation.
            // Its completion belongs to this frame load, not the retired viewing scope.
            const controller = new AbortController();
            creationControllers.add(controller);
            const request = createCredentialRequest(admitted.token, controller,
                () => !disposed && !controller.signal.aborted,
                () => current(target) && scope === admitted);
            const executor = createDefaultActionExecutor({ apiTokenAction: { request, target: { kind: 'machine', machineId: payload.executionTarget.machineId } } });
            const operation: NonNullable<typeof creation> = { intent: target, attemptId: attempt.attemptId,
                tokenId: admitted.self.credentialId, promise: Promise.resolve({ sessionId: '' }) };
            operation.promise = (async () => {
                try {
                    const { executeSessionSpawnNewAction } = await import('@/sync/ops/actions/sessionSpawnNewAction');
                    if (!current(target) || scope !== admitted) throw new Error('credential_unavailable');
                    const action = await executeSessionSpawnNewAction(payload, { surface: 'ui', serverId: input.endpointUrl, signal: controller.signal }, executor);
                    // Match the canonical New Session owner's settled Action-refusal contract.
                    // Transport failures throw; a pending spawn remains retryable below.
                    if (!action.ok) throw Object.assign(new Error(action.errorCode), { code: action.errorCode, retryable: false });
                    if (action.result.type !== 'success') {
                        if (action.result.type === 'pending') throw new Error('credential_unavailable');
                        throw Object.assign(new Error(action.result.code), { code: action.result.code, retryable: action.result.retryable });
                    }
                    const sessionId = action.result.sessionId;
                    operation.sessionId = sessionId;
                    bridge?.sessionCreated(sessionId);
                    if (!current(target)) return { sessionId };
                    target.sessionId = sessionId;
                    target.createdByTokenId = operation.tokenId;
                    publish({ ...snapshot, phase: 'loading', requestedSessionId: sessionId });
                    input.navigate?.(sessionId);
                    await requestCredential('created');
                    if (!current(target) || snapshot.phase !== 'ready' || snapshot.displayedSessionId !== sessionId) {
                        throw new Error(current(target) ? snapshot.error ?? 'credential_unavailable' : 'credential_unavailable');
                    }
                    return { sessionId };
                } finally {
                    creationControllers.delete(controller);
                    controller.abort('embed-creation-settled');
                }
            })();
            creation = operation;
            try { return await operation.promise; } catch (error) {
                if (!operation.sessionId && creation === operation) creation = null;
                throw error;
            }
        },
        dispose() {
            if (disposed) return;
            retire(false);
            disposed = true;
            for (const controller of creationControllers) controller.abort('embed-frame-disposed');
            creationControllers.clear();
            snapshot = { ...snapshot, phase: 'error', error: 'credential_unavailable', requestedSessionId: null,
                displayedSessionId: null, credential: null, self: null, creationConfig: null, creationModels: null };
            pendingCredential = null;
            creation = null;
            bridge = null;
            parentOrigin = null;
            ancestors = [];
            input.encryption.dispose();
            listeners.clear();
        },
    };
}
export type EmbedSessionRuntime = ReturnType<typeof createEmbedSessionRuntime>;

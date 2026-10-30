import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async original => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
let daemonReply: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
installSessionActionRpcBoundary((wire, context) => {
    const separator = wire.method.indexOf(':');
    return daemonReply(wire.method.slice(separator + 1), wire.params, context.signal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { isCapturedVoiceExecutionMachineCurrent } = await import('@/voice/settings/executionMachine');
const { createVoiceClientRawCredentialAccess } = await import('./rawCredentialClient');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function createRawAccess(reply: typeof daemonReply, input: Parameters<typeof createVoiceClientRawCredentialAccess>[0]) {
    daemonReply = reply;
    return createVoiceClientRawCredentialAccess({ ...input, machineId: input.machineId ?? 'machine-a' });
}

function selectMachine(machineId: string) {
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
        voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId } },
    }, storage.getState().settings));
}

const identity = Object.freeze({
    pluginId: 'acme.voice',
    contributionId: 'browser',
    artifactId: 'browser-artifact',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    platform: 'web' as const,
});
const request = Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
});

describe('Voice client raw credential adapter', () => {
    beforeEach(async () => {
        account = await restoreServerAccountForTest({
            serverUrl: 'https://raw-credential.test', accountId: 'account-a', credentialScope: 'restored-home',
      request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/machines') return Response.json(['machine-a', 'machine-b'].map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        const machine = /^\/v1\/machines\/([^/]+)$/.exec(path);
                if (machine) return Response.json({ machine: createPlainMachineRowFixture({ id: machine[1]!, accountId: 'account-a' }) });
                return null;
            },
        });
        storage.getState().applyMachines(['machine-a', 'machine-b'].map(id => createMachineFixture({ id, activeAt: Date.now() })));
        selectMachine('machine-a');
    });
    afterEach(async () => { await account?.dispose(); account = null; });
    it('binds the exact current identity and phase while returning copied headers', async () => {
        const responseHeaders = { authorization: 'Bearer exact-account' };
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: responseHeaders },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }));
        const raw = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });

        const materialized = await raw.materialize(request);
        responseHeaders.authorization = 'mutated-after-return';

        expect(materialized).toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer exact-account' },
        });
        expect(invoke).toHaveBeenCalledWith(
            RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
            {
                contribution: { pluginId: identity.pluginId, localId: identity.contributionId },
                platform: identity.platform,
                cacheIdentity: { artifactDigest: identity.artifactDigest },
                phase: 'connection',
                expectedCredentialRevision: null,
                request,
            },
            expect.any(AbortSignal),
        );
    });

    it('rejects a callback materialization that does not return an opaque currentness receipt', async () => {
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer missing-receipt' } },
            credentialRevision: null,
        }));
        const raw = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });

        await expect(raw.materialize(request)).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
    });

    it('pins one daemon-reported Connected Account revision for the full callback', async () => {
        const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
        let credentialRevision = revisionA;
        const invoke = vi.fn(async () => {
            return {
                ok: true,
                materialization: {
                    kind: 'httpHeaders',
                    headers: { authorization: `Bearer ${credentialRevision}` },
                },
                credentialRevision,
            };
        });
        const firstCallback = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });

        await expect(firstCallback.materialize(request)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: `Bearer ${revisionA}` },
        });
        credentialRevision = revisionB;
        await expect(firstCallback.materialize(request)).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        expect(invoke).toHaveBeenNthCalledWith(
            1,
            RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
            {
                contribution: { pluginId: identity.pluginId, localId: identity.contributionId },
                platform: identity.platform,
                cacheIdentity: { artifactDigest: identity.artifactDigest },
                phase: 'connection',
                expectedCredentialRevision: null,
                request,
            },
            expect.any(AbortSignal),
        );
        expect(invoke).toHaveBeenNthCalledWith(
            2,
            RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
            {
                contribution: { pluginId: identity.pluginId, localId: identity.contributionId },
                platform: identity.platform,
                cacheIdentity: { artifactDigest: identity.artifactDigest },
                phase: 'connection',
                expectedCredentialRevision: revisionA,
                request,
            },
            expect.any(AbortSignal),
        );

        const nextCallback = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });
        await expect(nextCallback.materialize(request)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: `Bearer ${revisionB}` },
        });
        expect(invoke).toHaveBeenNthCalledWith(
            3,
            RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
            {
                contribution: { pluginId: identity.pluginId, localId: identity.contributionId },
                platform: identity.platform,
                cacheIdentity: { artifactDigest: identity.artifactDigest },
                phase: 'connection',
                expectedCredentialRevision: null,
                request,
            },
            expect.any(AbortSignal),
        );
    });

    it('rejects environment access before RPC and drops a result after generation retirement', async () => {
        let current = true;
        const success = {
            ok: true,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer exact-account' } },
        };
        const pending = createDeferred<unknown>();
        const invoked = createDeferred<void>();
        const invoke = vi.fn(async () => {
            invoked.resolve();
            return await pending.promise;
        });
        const raw = createRawAccess(invoke, {
            identity,
            phase: 'prepare',
            signal: new AbortController().signal,
            isCurrent: () => current,
            isInvocationCurrent: () => true,
        });

        await expect(raw.materialize({ kind: 'environment', keys: ['VOICE_TOKEN'] })).rejects.toMatchObject({
            code: 'plugin_voice_provider_result_invalid',
        });
        expect(invoke).not.toHaveBeenCalled();

        const operation = raw.materialize(request);
        await invoked.promise;
        expect(invoke).toHaveBeenCalledOnce();
        current = false;
        pending.resolve(success);
        await expect(operation).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });

        const fresh = createRawAccess(async () => success, {
            identity,
            phase: 'prepare',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });
        await expect(fresh.materialize(request)).resolves.toEqual(success.materialization);
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('does not retain raw access after its host invocation settles or is aborted', async () => {
        const lifetime = new AbortController();
        const success = {
            ok: true,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer exact-account' } },
        };
        const pending = createDeferred<unknown>();
        const invoked = createDeferred<void>();
        const invoke = vi.fn(async () => {
            invoked.resolve();
            return await pending.promise;
        });
        const raw = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            // The public object must be bound to its host-owned invocation,
            // rather than silently allocating a new unbounded lifetime.
            signal: lifetime.signal,
        });

        const inFlight = raw.materialize(request);
        await invoked.promise;
        expect(invoke).toHaveBeenCalledOnce();
        lifetime.abort();
        pending.resolve(success);

        await expect(inFlight).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        await expect(raw.materialize(request)).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        expect(invoke).toHaveBeenCalledOnce();
        expect(Object.keys(raw)).toEqual(['materialize']);
        expect(Reflect.get(raw, 'inspectAuthorization')).toBeUndefined();

        const fresh = createRawAccess(async () => success, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });
        await expect(fresh.materialize(request)).resolves.toEqual(success.materialization);
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('does not follow a changed credential source during one live host invocation', async () => {
        let sourceCurrent = true;
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer exact-source' } },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }));
        const raw = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            // The activation remains current; this is the separately captured
            // account credential/source authority for this invocation.
            isInvocationCurrent: () => sourceCurrent,
        });

        await expect(raw.materialize(request)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer exact-source' },
        });
        sourceCurrent = false;

        await expect(raw.materialize(request)).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('does not dispatch a second raw request after its captured machine stops being selected', async () => {
        const capturedMachineId = 'machine-a';
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer machine-a' } },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }));
        const raw = createRawAccess(invoke, {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            machineId: capturedMachineId,
            // The activation owner composes this predicate from the same
            // captured target and the canonical execution-machine resolver.
            isInvocationCurrent: () => isCapturedVoiceExecutionMachineCurrent(capturedMachineId),
        });

        await expect(raw.materialize(request)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer machine-a' },
        });
        selectMachine('machine-b');

        await expect(raw.materialize(request)).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        expect(invoke).toHaveBeenCalledOnce();
    });

    it.each([
        'plugin_voice_provider_result_invalid',
        'plugin_voice_credential_access_unavailable',
        'plugin_voice_provider_operation_failed',
    ] as const)('preserves the stable public Voice error %s', async (errorCode) => {
        const raw = createRawAccess(async () => ({ ok: false, errorCode }), {
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
        });

        const operation = raw.materialize(request);
        await expect(operation).rejects.toMatchObject({ code: errorCode });
        await expect(operation).rejects.not.toHaveProperty('cause');
    });
});

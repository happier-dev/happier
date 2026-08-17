import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createVoiceClientRawCredentialAccess } from './rawCredentialClient';

const identity = Object.freeze({
    pluginId: 'acme.voice',
    contributionId: 'browser',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'web' as const,
    channel: 'internal' as const,
    nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
    projectionGeneration: 12,
});
const request = Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

describe('Voice client raw credential adapter', () => {
    it('binds the exact current identity and phase while returning copied headers', async () => {
        const responseHeaders = { authorization: 'Bearer exact-account' };
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: responseHeaders },
            credentialRevision: null,
        }));
        const raw = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            client: { invoke },
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
                cacheIdentity: identity,
                phase: 'connection',
                expectedCredentialRevision: null,
                request,
            },
            expect.any(AbortSignal),
        );
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
        const firstCallback = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            client: { invoke },
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
                cacheIdentity: identity,
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
                cacheIdentity: identity,
                phase: 'connection',
                expectedCredentialRevision: revisionA,
                request,
            },
            expect.any(AbortSignal),
        );

        const nextCallback = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            client: { invoke },
        });
        await expect(nextCallback.materialize(request)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: `Bearer ${revisionB}` },
        });
        expect(invoke).toHaveBeenNthCalledWith(
            3,
            RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
            {
                cacheIdentity: identity,
                phase: 'connection',
                expectedCredentialRevision: null,
                request,
            },
            expect.any(AbortSignal),
        );
    });

    it('rejects environment access before RPC and drops a result after generation retirement', async () => {
        let current = true;
        const pending = deferred<unknown>();
        const invoke = vi.fn(async () => await pending.promise);
        const raw = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'prepare',
            signal: new AbortController().signal,
            isCurrent: () => current,
            isInvocationCurrent: () => true,
            client: { invoke },
        });

        await expect(raw.materialize({ kind: 'environment', keys: ['VOICE_TOKEN'] })).rejects.toMatchObject({
            code: 'plugin_voice_provider_result_invalid',
        });
        expect(invoke).not.toHaveBeenCalled();

        const operation = raw.materialize(request);
        current = false;
        pending.resolve({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'stale' } },
        });
        await expect(operation).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
    });

    it('does not retain raw access after its host invocation settles or is aborted', async () => {
        const lifetime = new AbortController();
        const pending = deferred<unknown>();
        const invoke = vi.fn(async () => await pending.promise);
        const raw = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            client: { invoke },
            // The public object must be bound to its host-owned invocation,
            // rather than silently allocating a new unbounded lifetime.
            signal: lifetime.signal,
        });

        const inFlight = raw.materialize(request);
        expect(invoke).toHaveBeenCalledOnce();
        lifetime.abort();
        pending.resolve({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'stale' } },
        });

        await expect(inFlight).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        await expect(raw.materialize(request)).rejects.toMatchObject({
            code: 'plugin_voice_credential_access_unavailable',
        });
        expect(invoke).toHaveBeenCalledOnce();
        expect(Object.keys(raw)).toEqual(['materialize']);
        expect(Reflect.get(raw, 'inspectAuthorization')).toBeUndefined();
    });

    it('does not follow a changed credential source during one live host invocation', async () => {
        let sourceCurrent = true;
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer exact-source' } },
            credentialRevision: null,
        }));
        const raw = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            // The activation remains current; this is the separately captured
            // account credential/source authority for this invocation.
            isInvocationCurrent: () => sourceCurrent,
            client: { invoke },
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
        let selectedMachineId = capturedMachineId;
        const invoke = vi.fn(async () => ({
            ok: true,
            materialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer machine-a' } },
            credentialRevision: null,
        }));
        const raw = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            machineId: capturedMachineId,
            // The activation owner composes this predicate from the same
            // captured target and the canonical execution-machine resolver.
            isInvocationCurrent: () => selectedMachineId === capturedMachineId,
            client: { invoke },
        });

        await expect(raw.materialize(request)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer machine-a' },
        });
        selectedMachineId = 'machine-b';

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
        const raw = createVoiceClientRawCredentialAccess({
            identity,
            phase: 'connection',
            signal: new AbortController().signal,
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            client: { invoke: async () => ({ ok: false, errorCode }) },
        });

        const operation = raw.materialize(request);
        await expect(operation).rejects.toMatchObject({ code: errorCode });
        await expect(operation).rejects.not.toHaveProperty('cause');
    });
});

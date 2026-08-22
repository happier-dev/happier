import { describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
    AgentExternalSessionsManagedEndpointReadResponse,
    AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionSource,
    AgentExternalSessionsListCandidatesRequest,
    AgentExternalSessionsPageTranscriptRequest,
    AgentExternalSessionsReadAfterTranscriptRequest,
    AgentExternalSessionsResolveLinkedIdentityRequest,
    AgentExternalSessionsResolveLinkIdentityRequest,
    AgentExternalSessionsResolveSourceRequest,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
    createBoundedAgentExternalSessionsContribution,
    type BoundedAgentExternalSessionsContribution,
} from './agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const identity = Object.freeze({
    pluginId: 'acme.external',
    agentId: 'acme-agent',
    generation: 'generation-7',
    contributionQualifiedId: 'acme.external/agents/acme-agent',
    immutableGenerationId: 'immutable-generation-7',
});
const source = Object.freeze({ kind: 'fixture', root: '/tmp/sessions' });
/**
 * The canonical transcript record every Agent contribution must emit. Fixtures
 * that only needed "some object" here would no longer be admissible, so they
 * share this record rather than each inventing a provider-native envelope.
 */
const canonicalTranscriptRaw = Object.freeze({
    role: 'user',
    content: Object.freeze({ type: 'text', text: 'hello' }),
});
const unavailableManagedEndpointRead = async (): Promise<AgentExternalSessionsManagedEndpointReadResponse> => {
    throw new Error('unavailable');
};
const unavailableInvocationExec = createUnavailablePluginServices().exec;

type MethodName =
    | 'resolveSource'
    | 'listCandidates'
    | 'resolveLinkIdentity'
    | 'resolveLinkedIdentity'
    | 'pageTranscript'
    | 'readAfterTranscript';
type ContributionRequest =
    | AgentExternalSessionsResolveSourceRequest
    | AgentExternalSessionsListCandidatesRequest
    | AgentExternalSessionsResolveLinkIdentityRequest
    | AgentExternalSessionsResolveLinkedIdentityRequest
    | AgentExternalSessionsPageTranscriptRequest
    | AgentExternalSessionsReadAfterTranscriptRequest;
type BoundedContributionRequest =
    | Parameters<BoundedAgentExternalSessionsContribution['resolveSource']>[0]
    | Parameters<BoundedAgentExternalSessionsContribution['listCandidates']>[0]
    | Parameters<BoundedAgentExternalSessionsContribution['resolveLinkIdentity']>[0]
    | Parameters<BoundedAgentExternalSessionsContribution['resolveLinkedIdentity']>[0]
    | Parameters<BoundedAgentExternalSessionsContribution['pageTranscript']>[0]
    | Parameters<BoundedAgentExternalSessionsContribution['readAfterTranscript']>[0];

function requestFor(method: 'resolveSource', signal?: AbortSignal): Parameters<BoundedAgentExternalSessionsContribution['resolveSource']>[0];
function requestFor(method: 'listCandidates', signal?: AbortSignal): Parameters<BoundedAgentExternalSessionsContribution['listCandidates']>[0];
function requestFor(method: 'resolveLinkIdentity', signal?: AbortSignal): Parameters<BoundedAgentExternalSessionsContribution['resolveLinkIdentity']>[0];
function requestFor(method: 'resolveLinkedIdentity', signal?: AbortSignal): Parameters<BoundedAgentExternalSessionsContribution['resolveLinkedIdentity']>[0];
function requestFor(method: 'pageTranscript', signal?: AbortSignal): Parameters<BoundedAgentExternalSessionsContribution['pageTranscript']>[0];
function requestFor(method: 'readAfterTranscript', signal?: AbortSignal): Parameters<BoundedAgentExternalSessionsContribution['readAfterTranscript']>[0];
function requestFor(
    method: MethodName,
    signal = new AbortController().signal,
): BoundedContributionRequest {
    const invocation = {
        signal,
        deadlineAtMs: Number.MAX_SAFE_INTEGER,
        maxSerializedBytes: Number.MAX_SAFE_INTEGER,
    };
    switch (method) {
        case 'resolveSource':
            return { ...invocation, source };
        case 'listCandidates':
            return { ...invocation, source, cursor: undefined, maxItems: 9_999, searchTerm: 'needle', searchMode: 'fast' as const };
        case 'resolveLinkIdentity':
            return { ...invocation, source, remoteSessionId: 'remote-1', linkData: { key: 'value' } };
        case 'resolveLinkedIdentity':
            return { ...invocation, source, remoteSessionId: 'remote-1', linkData: { key: 'value' } };
        case 'pageTranscript':
            return { ...invocation, source, remoteSessionId: 'remote-1', direction: 'older' as const, maxItems: 9_999 };
        case 'readAfterTranscript':
            return { ...invocation, source, remoteSessionId: 'remote-1', cursor: 'leaf-cursor', maxItems: 9_999 };
    }
}

function successFor(method: MethodName): AgentExternalSessionsResult<unknown> {
    switch (method) {
        case 'resolveSource':
            return { ok: true, value: { source } };
        case 'listCandidates':
            return { ok: true, value: { candidates: [], nextCursor: null } };
        case 'resolveLinkIdentity':
        case 'resolveLinkedIdentity':
            return { ok: true, value: { source, remoteSessionId: 'remote-1', linkData: { key: 'value' } } };
        case 'pageTranscript':
            return { ok: true, value: { items: [], nextCursor: null } };
        case 'readAfterTranscript':
            return { ok: true, value: { outcome: 'already_current' } };
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function exactOpaqueCodeUnits(maximum: number): string {
    return "external::/%?=+#[]@!$&'()*+,;🙂".padEnd(maximum, 'x');
}

function contributionWith(
    implementation: (method: MethodName, request: ContributionRequest) => AgentExternalSessionsResult<unknown> | Promise<AgentExternalSessionsResult<unknown>>,
): AgentExternalSessionsContribution {
    return Object.freeze({
        resolveSource: (request) => implementation('resolveSource', request) as ReturnType<AgentExternalSessionsContribution['resolveSource']>,
        listCandidates: (request) => implementation('listCandidates', request) as ReturnType<AgentExternalSessionsContribution['listCandidates']>,
        resolveLinkIdentity: (request) => implementation('resolveLinkIdentity', request) as ReturnType<AgentExternalSessionsContribution['resolveLinkIdentity']>,
        resolveLinkedIdentity: (request) => implementation('resolveLinkedIdentity', request) as ReturnType<AgentExternalSessionsContribution['resolveLinkedIdentity']>,
        pageTranscript: (request) => implementation('pageTranscript', request) as ReturnType<AgentExternalSessionsContribution['pageTranscript']>,
        readAfterTranscript: (request) => implementation('readAfterTranscript', request) as ReturnType<AgentExternalSessionsContribution['readAfterTranscript']>,
    });
}

async function invoke(
    contribution: BoundedAgentExternalSessionsContribution,
    method: MethodName,
    signal = new AbortController().signal,
): Promise<AgentExternalSessionsResult<unknown>> {
    switch (method) {
        case 'resolveSource':
            return await contribution.resolveSource(requestFor('resolveSource', signal));
        case 'listCandidates':
            return await contribution.listCandidates(requestFor('listCandidates', signal));
        case 'resolveLinkIdentity':
            return await contribution.resolveLinkIdentity(requestFor('resolveLinkIdentity', signal));
        case 'resolveLinkedIdentity':
            return await contribution.resolveLinkedIdentity(requestFor('resolveLinkedIdentity', signal));
        case 'pageTranscript':
            return await contribution.pageTranscript(requestFor('pageTranscript', signal));
        case 'readAfterTranscript':
            return await contribution.readAfterTranscript(requestFor('readAfterTranscript', signal));
    }
}

function createWrapper(params?: Readonly<{
    contribution?: AgentExternalSessionsContribution;
    isCurrent?: () => boolean;
    retirementSignal?: AbortSignal;
    managedEndpointRead?: Parameters<
        typeof createBoundedAgentExternalSessionsContribution
    >[0]['managedEndpointRead'];
    createInvocationExec?: Parameters<
        typeof createBoundedAgentExternalSessionsContribution
    >[0]['createInvocationExec'];
}>) {
    return createBoundedAgentExternalSessionsContribution({
        contribution: params?.contribution ?? contributionWith((method) => successFor(method)),
        identity,
        isCurrent: params?.isCurrent ?? (() => true),
        retirementSignal: params?.retirementSignal ?? new AbortController().signal,
        createInvocationExec: params?.createInvocationExec ?? (async () => unavailableInvocationExec),
        ...(params?.managedEndpointRead
            ? { managedEndpointRead: params.managedEndpointRead }
            : {}),
    });
}

describe('bounded Agent External Sessions invocation', () => {
    it('stamps generic execution authority instead of requiring it from host-facing requests', async () => {
        const createInvocationExec = vi.fn(async () => unavailableInvocationExec);
        const hostSuppliedExec = createUnavailablePluginServices().exec;
        let receivedRequest: AgentExternalSessionsResolveSourceRequest | undefined;
        const wrapped = createWrapper({
            createInvocationExec,
            contribution: contributionWith((_method, request) => {
                receivedRequest = request as AgentExternalSessionsResolveSourceRequest;
                return successFor('resolveSource');
            }),
        });
        const signal = new AbortController().signal;
        const hostRequest = {
            source,
            signal,
            deadlineAtMs: Number.MAX_SAFE_INTEGER,
            maxSerializedBytes: Number.MAX_SAFE_INTEGER,
        } satisfies Parameters<typeof wrapped.resolveSource>[0];
        // An untyped host caller could still append this property at runtime;
        // the wrapper must stamp its generation-owned authority over it.
        const runtimeOnlyHostRequest = { ...hostRequest, exec: hostSuppliedExec };

        await expect(wrapped.resolveSource(runtimeOnlyHostRequest)).resolves.toEqual(successFor('resolveSource'));

        expect(createInvocationExec).toHaveBeenCalledOnce();
        expect(createInvocationExec).toHaveBeenCalledWith(receivedRequest?.signal);
        expect(receivedRequest?.exec).toBe(unavailableInvocationExec);
        expect(receivedRequest?.exec).not.toBe(hostSuppliedExec);
    });

    it('binds the exact managed endpoint read once before contribution entry and retires it when the contribution settles', async () => {
        const admittedRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({ 'x-next-cursor': 'cursor-2' }),
            body: null,
        }));
        const replacementRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 299,
            statusText: 'Replacement',
            headers: Object.freeze({}),
            body: null,
        }));
        let selectedRead: AgentExternalSessionsManagedEndpointRead = admittedRead;
        const delegated = vi.fn(async () => selectedRead);
        let capturedRequest: AgentExternalSessionsResolveSourceRequest | null = null;
        let inContributionResponse: AgentExternalSessionsManagedEndpointReadResponse | null = null;
        let current = true;
        const wrapped = createWrapper({
            isCurrent: () => current,
            managedEndpointRead: delegated,
            contribution: contributionWith(async (_method, request) => {
                capturedRequest = request as AgentExternalSessionsResolveSourceRequest;
                expect(delegated).toHaveBeenCalledOnce();
                expect(delegated).toHaveBeenCalledWith({
                    identity,
                    source,
                    signal: capturedRequest.signal,
                });
                selectedRead = replacementRead;
                inContributionResponse = await capturedRequest.managedEndpointRead({
                    pathAndQuery: '/session?directory=workspace',
                    headers: { accept: 'application/json' },
                });
                return successFor('resolveSource');
            }),
        });

        await wrapped.resolveSource(requestFor('resolveSource'));
        const endpointRead = capturedRequest!.managedEndpointRead;

        expect(inContributionResponse).toMatchObject({ status: 200, body: null });
        expect(delegated).toHaveBeenCalledWith({
            identity,
            source,
            signal: capturedRequest!.signal,
        });
        expect(admittedRead).toHaveBeenCalledWith({
            pathAndQuery: '/session?directory=workspace',
            headers: { accept: 'application/json' },
        });
        expect(replacementRead).not.toHaveBeenCalled();
        expect(Object.keys(endpointRead)).toEqual([]);

        await expect(endpointRead({ pathAndQuery: '/session/status' }))
            .rejects.toThrow('settled');
        expect(delegated).toHaveBeenCalledOnce();
        expect(admittedRead).toHaveBeenCalledOnce();
        expect(replacementRead).not.toHaveBeenCalled();

        current = false;
        await expect(endpointRead({
            pathAndQuery: '/session',
        })).rejects.toThrow('retired generation');
        expect(delegated).toHaveBeenCalledOnce();
        expect(admittedRead).toHaveBeenCalledOnce();
        expect(replacementRead).not.toHaveBeenCalled();
    });

    it.each([
        'resolveSource',
        'listCandidates',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'pageTranscript',
        'readAfterTranscript',
    ] as const)('binds managed endpoint authority before %s contribution entry', async (method) => {
        const delegated = vi.fn(async () => unavailableManagedEndpointRead);
        const wrapped = createWrapper({
            managedEndpointRead: delegated,
            contribution: contributionWith((calledMethod, request) => {
                expect(calledMethod).toBe(method);
                expect(delegated).toHaveBeenCalledOnce();
                expect(delegated).toHaveBeenCalledWith({
                    identity,
                    source,
                    signal: request.signal,
                });
                expect(request.exec).toBe(unavailableInvocationExec);
                return successFor(calledMethod);
            }),
        });

        await expect(invoke(wrapped, method)).resolves.toMatchObject({ ok: true });
        expect(delegated).toHaveBeenCalledOnce();
    });

    it('cancels a late managed endpoint response body after successful contribution settlement', async () => {
        const started = deferred<void>();
        const response = deferred<AgentExternalSessionsManagedEndpointReadResponse>();
        const cancelBody = vi.fn();
        const exactRead = vi.fn(async () => {
            started.resolve();
            return await response.promise;
        });
        let retainedRead: Promise<AgentExternalSessionsManagedEndpointReadResponse> | null = null;
        const wrapped = createWrapper({
            managedEndpointRead: vi.fn(async () => exactRead),
            contribution: contributionWith(async (_method, request) => {
                const invocation = request as AgentExternalSessionsResolveSourceRequest;
                retainedRead = invocation.managedEndpointRead({
                    pathAndQuery: '/session',
                });
                void retainedRead.catch(() => undefined);
                await started.promise;
                return successFor('resolveSource');
            }),
        });

        await expect(wrapped.resolveSource(requestFor('resolveSource')))
            .resolves.toMatchObject({ ok: true });
        const body = new ReadableStream<Uint8Array>({
            cancel: cancelBody,
        });
        response.resolve(Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body,
        }));

        await expect(retainedRead).rejects.toThrow('settled');
        expect(cancelBody).toHaveBeenCalledOnce();
    });

    it('rejects unavailable managed endpoint reads before delegation effects', async () => {
        let managedEndpointReadError: unknown = null;
        const wrapped = createWrapper({
            contribution: contributionWith(async (_method, request) => {
                const invocation = request as AgentExternalSessionsResolveSourceRequest;
                try {
                    await invocation.managedEndpointRead({
                        pathAndQuery: '/session',
                    });
                } catch (error) {
                    managedEndpointReadError = error;
                }
                return successFor('resolveSource');
            }),
        });

        await expect(wrapped.resolveSource(requestFor('resolveSource')))
            .resolves.toMatchObject({ ok: true });
        expect(managedEndpointReadError).toEqual(expect.objectContaining({
            message: expect.stringContaining('unavailable'),
        }));
    });

    it.each([
        ['Authorization', 'Bearer caller-secret'],
        ['Proxy-Authorization', 'Basic proxy-secret'],
        ['Cookie', 'session=caller-secret'],
        ['X-Api-Key', 'caller-secret'],
    ] as const)(
        'rejects managed endpoint %s before the bound endpoint can fetch',
        async (name, value) => {
            const exactRead = vi.fn(unavailableManagedEndpointRead);
            const delegated = vi.fn(async () => exactRead);
            let rejection: unknown;
            const wrapped = createWrapper({
                managedEndpointRead: delegated,
                contribution: contributionWith(async (_method, request) => {
                    try {
                        await request.managedEndpointRead({
                            pathAndQuery: '/session',
                            headers: { [name]: value },
                        });
                    } catch (error) {
                        rejection = error;
                    }
                    return successFor('resolveSource');
                }),
            });

            await expect(wrapped.resolveSource(requestFor('resolveSource')))
                .resolves.toMatchObject({ ok: true });
            expect(rejection).toBeInstanceOf(Error);
            expect((rejection as Error).message).toContain(
                'cannot supply authentication',
            );
            expect(delegated).toHaveBeenCalledOnce();
            expect(exactRead).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['resolveSource', 262_144, undefined],
        ['listCandidates', 1_048_576, 50],
        ['resolveLinkIdentity', 262_144, undefined],
        ['resolveLinkedIdentity', 262_144, undefined],
        ['pageTranscript', 524_288, 200],
        ['readAfterTranscript', 524_288, 200],
    ] as const)('applies the sole host policy to %s', async (method, maxSerializedBytes, maxItems) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const observed = vi.fn();
        const wrapped = createWrapper({
            contribution: contributionWith((calledMethod, request) => {
                observed(calledMethod, request);
                return successFor(calledMethod);
            }),
        });

        const resultPromise = invoke(wrapped, method);
        await vi.advanceTimersByTimeAsync(0);
        const result = await resultPromise;

        expect(result.ok).toBe(true);
        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.calls[0]?.[0]).toBe(method);
        expect(observed.mock.calls[0]?.[1]).toMatchObject({
            deadlineAtMs: 16_000,
            maxSerializedBytes,
            ...(maxItems === undefined ? {} : { maxItems }),
        });
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('uses the earlier caller-owned absolute deadline for a paged admission', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const observed = vi.fn();
        const wrapped = createWrapper({
            contribution: contributionWith((calledMethod, request) => {
                observed(calledMethod, request);
                return successFor(calledMethod);
            }),
        });

        const resultPromise = wrapped.pageTranscript({
            ...requestFor('pageTranscript'),
            deadlineAtMs: 2_000,
        });
        await vi.advanceTimersByTimeAsync(0);

        await expect(resultPromise).resolves.toMatchObject({ ok: true });
        expect(observed).toHaveBeenCalledWith(
            'pageTranscript',
            expect.objectContaining({ deadlineAtMs: 2_000 }),
        );
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('rejects an expired whole-admission deadline before the Agent leaf runs', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const observed = vi.fn();
        const wrapped = createWrapper({
            contribution: contributionWith((calledMethod) => {
                observed(calledMethod);
                return successFor(calledMethod);
            }),
        });

        await expect(wrapped.pageTranscript({
            ...requestFor('pageTranscript'),
            deadlineAtMs: 2_000,
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
            retryable: true,
        });
        expect(observed).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it.each([
        'resolveSource',
        'listCandidates',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'pageTranscript',
        'readAfterTranscript',
    ] as const)('rejects a pre-aborted %s call before leaf admission', async (method) => {
        const called = vi.fn();
        const controller = new AbortController();
        controller.abort();
        const wrapped = createWrapper({
            contribution: contributionWith((calledMethod) => {
                called(calledMethod);
                return successFor(calledMethod);
            }),
        });

        await expect(invoke(wrapped, method, controller.signal)).resolves.toEqual({
            ok: false,
            code: 'cancelled',
            retryable: false,
        });
        expect(called).not.toHaveBeenCalled();
    });

    it.each([
        'resolveSource',
        'listCandidates',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'pageTranscript',
        'readAfterTranscript',
    ] as const)('cancels an in-flight %s call and never admits its late result', async (method) => {
        const pending = deferred<AgentExternalSessionsResult<unknown>>();
        const caller = new AbortController();
        const wrapped = createWrapper({
            contribution: contributionWith(() => pending.promise),
        });

        const resultPromise = invoke(wrapped, method, caller.signal);
        await Promise.resolve();
        caller.abort();
        await expect(resultPromise).resolves.toEqual({
            ok: false,
            code: 'cancelled',
            retryable: false,
        });
        pending.resolve(successFor(method));
        await Promise.resolve();
    });

    it('times out once, drops late settlement, and cleans the caller listener and timer', async () => {
        vi.useFakeTimers();
        const pending = deferred<AgentExternalSessionsResult<unknown>>();
        const caller = new AbortController();
        const add = vi.spyOn(caller.signal, 'addEventListener');
        const remove = vi.spyOn(caller.signal, 'removeEventListener');
        const wrapped = createWrapper({ contribution: contributionWith(() => pending.promise) });

        const resultPromise = wrapped.resolveSource(requestFor('resolveSource', caller.signal));
        await vi.advanceTimersByTimeAsync(EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs);
        await expect(resultPromise).resolves.toEqual({
            ok: false,
            code: 'timeout',
            retryable: true,
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        pending.resolve(successFor('resolveSource'));
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
    });

    it.each([
        'resolveSource',
        'listCandidates',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'pageTranscript',
        'readAfterTranscript',
    ] as const)('retires an in-flight %s call and drops its late settlement', async (method) => {
        const pending = deferred<AgentExternalSessionsResult<unknown>>();
        const retirement = new AbortController();
        let current = true;
        const wrapped = createWrapper({
            contribution: contributionWith(() => pending.promise),
            isCurrent: () => current,
            retirementSignal: retirement.signal,
        });

        const resultPromise = invoke(wrapped, method);
        await Promise.resolve();
        current = false;
        retirement.abort();
        await expect(resultPromise).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            retryable: true,
        });
        pending.resolve(successFor(method));
        await Promise.resolve();
    });

    it('gives retirement precedence over concurrent caller cancellation and deadline, then refuses new calls', async () => {
        vi.useFakeTimers();
        const pending = deferred<AgentExternalSessionsResult<unknown>>();
        const caller = new AbortController();
        const retirement = new AbortController();
        let current = true;
        const entered = deferred<void>();
        const called = vi.fn(() => {
            entered.resolve();
            return pending.promise;
        });
        const wrapped = createWrapper({
            contribution: contributionWith(called),
            isCurrent: () => current,
            retirementSignal: retirement.signal,
        });

        const cancelledResult = wrapped.resolveSource(requestFor('resolveSource', caller.signal));
        await entered.promise;
        caller.abort();
        current = false;
        retirement.abort();
        await expect(cancelledResult).resolves.toEqual({ ok: false, code: 'unavailable', retryable: true });
        await expect(wrapped.resolveSource({
            ...requestFor('resolveSource'),
            maxSerializedBytes: 0,
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            retryable: true,
        });
        expect(called).toHaveBeenCalledOnce();
        pending.resolve(successFor('resolveSource'));
        await vi.advanceTimersByTimeAsync(EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs);
        vi.useRealTimers();
    });

    it.each([
        ['listCandidates', 'candidates', 50],
        ['pageTranscript', 'items', 200],
    ] as const)('accepts zero and exactly-max %s items, then rejects max-plus-one', async (method, field, maximum) => {
        const item = method === 'listCandidates'
            ? { remoteSessionId: 'remote-1', updatedAtMs: 1 }
            : { id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw };
        for (const count of [0, maximum]) {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: true,
                    value: method === 'listCandidates'
                        ? { candidates: Array.from({ length: count }, () => item), nextCursor: null }
                        : { items: Array.from({ length: count }, () => item), nextCursor: null },
                })),
            });
            const result = await invoke(wrapped, method);
            expect(result.ok && result.value).toMatchObject({ [field]: expect.any(Array) });
        }
        const wrapped = createWrapper({
            contribution: contributionWith(() => ({
                ok: true,
                value: method === 'listCandidates'
                    ? { candidates: Array.from({ length: maximum + 1 }, () => item), nextCursor: null }
                    : { items: Array.from({ length: maximum + 1 }, () => item), nextCursor: null },
            })),
        });
        await expect(invoke(wrapped, method)).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it('accepts exactly-max readAfter items and rejects max-plus-one', async () => {
        const maximum = EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems;
        const item = { id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw };
        const value = (count: number) => ({
            outcome: 'advanced',
            items: Array.from({ length: count }, () => item),
            nextCursor: 'native-next',
            boundary: 'item-1',
        });
        const accepted = createWrapper({
            contribution: contributionWith(() => ({ ok: true, value: value(maximum) })),
        });
        await expect(accepted.readAfterTranscript(requestFor('readAfterTranscript'))).resolves.toMatchObject({
            ok: true,
            value: { outcome: 'advanced', items: expect.any(Array) },
        });
        const rejected = createWrapper({
            contribution: contributionWith(() => ({ ok: true, value: value(maximum + 1) })),
        });
        await expect(rejected.readAfterTranscript(requestFor('readAfterTranscript'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it.each([
        ['candidate remote Session id', 'remoteSessionId', EXTERNAL_SESSIONS_INVOCATION_POLICY.idMaxCodeUnits],
        ['candidate title', 'title', EXTERNAL_SESSIONS_INVOCATION_POLICY.titleMaxCodeUnits],
    ] as const)(
        'accepts the exact %s code-unit bound without normalizing punctuation and rejects first-over',
        async (_label, field, maximum) => {
            const exact = exactOpaqueCodeUnits(maximum);
            const call = async (value: string) => {
                const candidate = {
                    remoteSessionId: 'remote-1',
                    updatedAtMs: 1,
                    [field]: value,
                };
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: { candidates: [candidate], nextCursor: null },
                    })),
                });
                return await wrapped.listCandidates(requestFor('listCandidates'));
            };

            await expect(call(exact)).resolves.toMatchObject({
                ok: true,
                value: { candidates: [{ [field]: exact }] },
            });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it.each([
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'pageTranscript',
        'readAfterTranscript',
    ] as const)(
        'accepts an exact remote Session id for %s and rejects first-over before leaf admission',
        async (method) => {
            const exact = exactOpaqueCodeUnits(EXTERNAL_SESSIONS_INVOCATION_POLICY.idMaxCodeUnits);
            const called = vi.fn();
            const wrapped = createWrapper({
                contribution: contributionWith((calledMethod) => {
                    called(calledMethod);
                    return successFor(calledMethod);
                }),
            });
            const call = async (remoteSessionId: string) => {
                switch (method) {
                    case 'resolveLinkIdentity':
                        return await wrapped.resolveLinkIdentity({
                            ...requestFor('resolveLinkIdentity'),
                            remoteSessionId,
                        });
                    case 'resolveLinkedIdentity':
                        return await wrapped.resolveLinkedIdentity({
                            ...requestFor('resolveLinkedIdentity'),
                            remoteSessionId,
                        });
                    case 'pageTranscript':
                        return await wrapped.pageTranscript({
                            ...requestFor('pageTranscript'),
                            remoteSessionId,
                        });
                    case 'readAfterTranscript':
                        return await wrapped.readAfterTranscript({
                            ...requestFor('readAfterTranscript'),
                            remoteSessionId,
                        });
                }
            };

            await expect(call(exact)).resolves.toMatchObject({ ok: true });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'invalid_request',
                retryable: false,
            });
            expect(called).toHaveBeenCalledOnce();
        },
    );

    it.each(['resolveLinkIdentity', 'resolveLinkedIdentity'] as const)(
        'accepts the exact resolved remote Session id returned by %s and rejects first-over',
        async (method) => {
            const exact = exactOpaqueCodeUnits(EXTERNAL_SESSIONS_INVOCATION_POLICY.idMaxCodeUnits);
            const call = async (remoteSessionId: string) => {
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: { source, remoteSessionId, linkData: { key: 'value' } },
                    })),
                });
                return method === 'resolveLinkIdentity'
                    ? await wrapped.resolveLinkIdentity(requestFor('resolveLinkIdentity'))
                    : await wrapped.resolveLinkedIdentity(requestFor('resolveLinkedIdentity'));
            };

            await expect(call(exact)).resolves.toMatchObject({
                ok: true,
                value: { remoteSessionId: exact },
            });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it.each([
        ['pageTranscript', 'id'],
        ['pageTranscript', 'localId'],
        ['readAfterTranscript', 'id'],
        ['readAfterTranscript', 'localId'],
    ] as const)(
        'accepts the exact %s item %s code-unit bound and rejects first-over',
        async (method, field) => {
            const exact = exactOpaqueCodeUnits(EXTERNAL_SESSIONS_INVOCATION_POLICY.idMaxCodeUnits);
            const call = async (value: string) => {
                const item = {
                    id: 'item-1',
                    createdAtMs: 1,
                    raw: canonicalTranscriptRaw,
                    [field]: value,
                };
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: method === 'pageTranscript'
                            ? { items: [item], nextCursor: null }
                            : {
                                outcome: 'advanced',
                                items: [item],
                                nextCursor: 'native-next',
                                boundary: 'item-1',
                            },
                    })),
                });
                return method === 'pageTranscript'
                    ? await wrapped.pageTranscript(requestFor('pageTranscript'))
                    : await wrapped.readAfterTranscript(requestFor('readAfterTranscript'));
            };

            await expect(call(exact)).resolves.toMatchObject({
                ok: true,
                value: { items: [{ [field]: exact }] },
            });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it.each(['pageTranscript', 'readAfterTranscript'] as const)(
        'admits a bounded sidechain identity returned by %s and rejects malformed values',
        async (method) => {
            const sidechainId = 's'.repeat(191);
            const call = async (value: unknown) => {
                const item = {
                    id: 'item-sidechain-1',
                    createdAtMs: 1,
                    sidechainId: value,
                    raw: canonicalTranscriptRaw,
                };
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: method === 'pageTranscript'
                            ? { items: [item], nextCursor: null }
                            : {
                                outcome: 'advanced',
                                items: [item],
                                nextCursor: 'native-next',
                                boundary: 'item-sidechain-1',
                            },
                    })),
                });
                return method === 'pageTranscript'
                    ? await wrapped.pageTranscript(requestFor('pageTranscript'))
                    : await wrapped.readAfterTranscript(requestFor('readAfterTranscript'));
            };

            await expect(call(sidechainId)).resolves.toMatchObject({
                ok: true,
                value: { items: [{ sidechainId }] },
            });
            await expect(call(` ${sidechainId} `)).resolves.toMatchObject({
                ok: true,
                value: { items: [{ sidechainId }] },
            });
            await expect(call(null)).resolves.toMatchObject({
                ok: true,
                value: { items: [{ sidechainId: null }] },
            });
            await expect(call(`${sidechainId}s`)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
            await expect(call('')).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    describe('transcript item raw record', () => {
        const callWithRaw = async (
            method: 'pageTranscript' | 'readAfterTranscript',
            raw: unknown,
        ) => {
            const item = { id: 'item-1', createdAtMs: 1, raw };
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: true,
                    value: method === 'pageTranscript'
                        ? { items: [item], nextCursor: null }
                        : {
                            outcome: 'advanced',
                            items: [item],
                            nextCursor: 'native-next',
                            boundary: 'item-1',
                        },
                })),
            });
            return method === 'pageTranscript'
                ? await wrapped.pageTranscript(requestFor('pageTranscript'))
                : await wrapped.readAfterTranscript(requestFor('readAfterTranscript'));
        };

        it.each(['pageTranscript', 'readAfterTranscript'] as const)(
            'admits canonical user and agent transcript records returned by %s',
            async (method) => {
                await expect(callWithRaw(method, {
                    role: 'user',
                    content: { type: 'text', text: 'hello' },
                })).resolves.toMatchObject({
                    ok: true,
                    value: { items: [{ raw: { role: 'user', content: { type: 'text', text: 'hello' } } }] },
                });
                await expect(callWithRaw(method, {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'message', message: 'done' },
                    },
                })).resolves.toMatchObject({
                    ok: true,
                    value: { items: [{ raw: { role: 'agent' } }] },
                });
            },
        );

        it.each([
            'source_fact',
            'terminal_origin',
            'host_prompt_echo',
        ] as const)('preserves the exact terminal user projection %s', async (userProjection) => {
            const item = {
                id: 'user-item-1',
                createdAtMs: 1,
                messageRole: 'user' as const,
                userProjection,
                raw: {
                    role: 'user' as const,
                    content: { type: 'text' as const, text: 'hello' },
                },
            };
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: true,
                    value: { items: [item], nextCursor: null },
                })),
            });

            await expect(wrapped.pageTranscript(
                requestFor('pageTranscript'),
            )).resolves.toMatchObject({
                ok: true,
                value: { items: [{ userProjection }] },
            });
        });

        it('rejects an unknown terminal user projection before returning the page', async () => {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: true,
                    value: {
                        items: [{
                            id: 'user-item-1',
                            createdAtMs: 1,
                            messageRole: 'user',
                            userProjection: 'guessed_from_text',
                            raw: {
                                role: 'user',
                                content: { type: 'text', text: 'hello' },
                            },
                        }],
                        nextCursor: null,
                    },
                })),
            });

            await expect(wrapped.pageTranscript(
                requestFor('pageTranscript'),
            )).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        });

        it.each([
            ['a provider-native envelope', { type: 'codex_event', payload: { kind: 'token_count' } }],
            ['an empty object', {}],
            ['an unknown role', { role: 'tool', content: { type: 'text', text: 'x' } }],
            ['a user record without text content', { role: 'user', content: { type: 'output' } }],
            ['an unknown envelope field', { role: 'user', content: { type: 'text', text: 'x' }, meta: { provider: 'legacy' } }],
            ['an unknown user-content field', { role: 'user', content: { type: 'text', text: 'x', providerTag: 'legacy' } }],
            ['a non-object record', 'hello'],
        ] as const)(
            'rejects %s as a transcript item raw record',
            async (_label, raw) => {
                await expect(callWithRaw('pageTranscript', raw)).resolves.toEqual({
                    ok: false,
                    code: 'agent_error',
                    retryable: false,
                });
                await expect(callWithRaw('readAfterTranscript', raw)).resolves.toEqual({
                    ok: false,
                    code: 'agent_error',
                    retryable: false,
                });
            },
        );

        it('rejects a compatibility messageRole that contradicts the canonical raw envelope', async () => {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: true,
                    value: {
                        items: [{
                            id: 'item-1',
                            createdAtMs: 1,
                            messageRole: 'agent',
                            raw: {
                                role: 'user',
                                content: { type: 'text', text: 'hello' },
                            },
                        }],
                        nextCursor: null,
                    },
                })),
            });

            await expect(wrapped.pageTranscript(
                requestFor('pageTranscript'),
            )).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        });

        it('rejects a user-only projection attached to an Agent envelope', async () => {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: true,
                    value: {
                        items: [{
                            id: 'item-1',
                            createdAtMs: 1,
                            userProjection: 'source_fact',
                            raw: {
                                role: 'agent',
                                content: { type: 'text', text: 'hello' },
                            },
                        }],
                        nextCursor: null,
                    },
                })),
            });

            await expect(wrapped.pageTranscript(
                requestFor('pageTranscript'),
            )).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        });

        it.each([
            { type: 'message', message: 'bare semantic body' },
            { type: 'acp', data: { type: 'message', message: 'missing agent identity' } },
        ])('rejects a non-canonical current Agent envelope %#', async (content) => {
            await expect(callWithRaw('pageTranscript', {
                role: 'agent',
                content,
            })).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        });

        it('admits a transcript record nested deeper than the link-data depth bound', async () => {
            let output: unknown = 'leaf';
            for (let depth = 0; depth < 12; depth += 1) output = { nested: output };
            await expect(callWithRaw('pageTranscript', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'call-1',
                        id: 'tool-1',
                        output,
                    },
                },
            })).resolves.toMatchObject({
                ok: true,
                value: { items: [{ raw: { role: 'agent' } }] },
            });
        });

        it('rejects accessor, prototype, cyclic, and non-finite transcript raw carriers', async () => {
            const accessor: Record<string, unknown> = { role: 'user' };
            Object.defineProperty(accessor, 'content', {
                enumerable: true,
                get: () => ({ type: 'text', text: 'x' }),
            });
            const cyclic: Record<string, unknown> = {
                role: 'user',
                content: { type: 'text', text: 'x' },
            };
            cyclic.self = cyclic;
            const carriers: readonly unknown[] = [
                accessor,
                Object.assign(Object.create({ inherited: true }), {
                    role: 'user',
                    content: { type: 'text', text: 'x' },
                }),
                cyclic,
                { role: 'user', content: { type: 'text', text: 'x' }, ordinal: Number.NaN },
            ];
            for (const raw of carriers) {
                await expect(callWithRaw('pageTranscript', raw)).resolves.toEqual({
                    ok: false,
                    code: 'agent_error',
                    retryable: false,
                });
            }
        });
    });

    it.each([
        ['read-after boundary', 2_000, (value: string) => ({ boundary: value })],
        ['read-after diagnostic code', 128, (value: string) => ({
            boundary: 'item-1',
            diagnostics: [{ code: value, count: 1, positions: [0] }],
        })],
    ] as const)(
        'accepts the exact %s code-unit bound and rejects first-over',
        async (_label, maximum, fields) => {
            const exact = exactOpaqueCodeUnits(maximum);
            const call = async (value: string) => {
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: {
                            outcome: 'advanced',
                            items: [{ id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw }],
                            nextCursor: 'native-next',
                            ...fields(value),
                        },
                    })),
                });
                return await wrapped.readAfterTranscript(requestFor('readAfterTranscript'));
            };

            await expect(call(exact)).resolves.toMatchObject({ ok: true });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it.each([
        ['source kind', EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceKindMaxCodeUnits],
        ['list search term', EXTERNAL_SESSIONS_INVOCATION_POLICY.searchMaxCodeUnits],
    ] as const)(
        'accepts the exact %s input code-unit bound and rejects first-over before leaf admission',
        async (field, maximum) => {
            const exact = exactOpaqueCodeUnits(maximum);
            const called = vi.fn();
            const wrapped = createWrapper({
                contribution: contributionWith((method) => {
                    called(method);
                    return successFor(method);
                }),
            });
            const call = async (value: string) => field === 'source kind'
                ? await wrapped.resolveSource({
                    ...requestFor('resolveSource'),
                    source: { kind: value },
                })
                : await wrapped.listCandidates({
                    ...requestFor('listCandidates'),
                    searchTerm: value,
                });

            await expect(call(exact)).resolves.toMatchObject({ ok: true });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'invalid_request',
                retryable: false,
            });
            expect(called).toHaveBeenCalledOnce();
        },
    );

    it('accepts an exact failure message and preserves the current first-over failure mapping', async () => {
        const exact = exactOpaqueCodeUnits(EXTERNAL_SESSIONS_INVOCATION_POLICY.failureMessageMaxCodeUnits);
        const call = async (message: string) => {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({
                    ok: false,
                    code: 'source_unreachable',
                    message,
                    retryable: true,
                })),
            });
            return await wrapped.resolveSource(requestFor('resolveSource'));
        };

        await expect(call(exact)).resolves.toEqual({
            ok: false,
            code: 'source_unreachable',
            message: exact,
            retryable: true,
        });
        await expect(call(`${exact}x`)).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it.each([
        ['listCandidates', 'nextCursor'],
        ['pageTranscript', 'nextCursor'],
        ['pageTranscript', 'tailCursor'],
        ['readAfterTranscript', 'nextCursor'],
    ] as const)(
        'accepts an exact native %s %s and rejects first-over',
        async (method, field) => {
            const exact = exactOpaqueCodeUnits(EXTERNAL_SESSIONS_INVOCATION_POLICY.nativeCursorMaxCodeUnits);
            const call = async (cursor: string) => {
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: method === 'listCandidates'
                            ? { candidates: [], nextCursor: cursor }
                            : method === 'pageTranscript'
                                ? { items: [], nextCursor: null, [field]: cursor }
                                : {
                                    outcome: 'advanced',
                                    items: [{ id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw }],
                                    nextCursor: cursor,
                                    boundary: 'item-1',
                                },
                    })),
                });
                return await invoke(wrapped, method);
            };

            await expect(call(exact)).resolves.toMatchObject({
                ok: true,
                value: { [field]: expect.stringMatching(/^happier_external_cursor_v1:/) },
            });
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it.each(['listCandidates', 'pageTranscript', 'readAfterTranscript'] as const)(
        'passes an exact native %s cursor through opaquely and rejects first-over before leaf admission',
        async (method) => {
            const exact = exactOpaqueCodeUnits(EXTERNAL_SESSIONS_INVOCATION_POLICY.nativeCursorMaxCodeUnits);
            const observed = vi.fn();
            const wrapped = createWrapper({
                contribution: contributionWith((calledMethod, request) => {
                    observed(calledMethod, request);
                    return successFor(calledMethod);
                }),
            });
            const call = async (cursor: string) => method === 'listCandidates'
                ? await wrapped.listCandidates({ ...requestFor('listCandidates'), cursor })
                : method === 'pageTranscript'
                    ? await wrapped.pageTranscript({ ...requestFor('pageTranscript'), cursor })
                    : await wrapped.readAfterTranscript({ ...requestFor('readAfterTranscript'), cursor });

            await expect(call(exact)).resolves.toMatchObject({ ok: true });
            expect(observed).toHaveBeenCalledWith(method, expect.objectContaining({ cursor: exact }));
            await expect(call(`${exact}x`)).resolves.toEqual({
                ok: false,
                code: 'invalid_request',
                retryable: false,
            });
            expect(observed).toHaveBeenCalledOnce();
        },
    );

    it.each(['listCandidates', 'pageTranscript', 'readAfterTranscript'] as const)(
        'rejects a zero-capacity %s request before leaf admission',
        async (method) => {
            const called = vi.fn();
            const wrapped = createWrapper({
                contribution: contributionWith((calledMethod) => {
                    called(calledMethod);
                    return successFor(calledMethod);
                }),
            });
            const result = method === 'listCandidates'
                ? await wrapped.listCandidates({ ...requestFor('listCandidates'), maxItems: 0 })
                : method === 'pageTranscript'
                    ? await wrapped.pageTranscript({ ...requestFor('pageTranscript'), maxItems: 0 })
                    : await wrapped.readAfterTranscript({ ...requestFor('readAfterTranscript'), maxItems: 0 });
            expect(result).toEqual({ ok: false, code: 'invalid_request', retryable: false });
            expect(called).not.toHaveBeenCalled();
        },
    );

    it('accepts only the explicit read-after outcome union and bounds empty-advance diagnostics', async () => {
        const call = async (value: unknown) => {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({ ok: true, value })),
            });
            return await wrapped.readAfterTranscript(requestFor('readAfterTranscript'));
        };

        await expect(call({ items: [], nextCursor: null })).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
        await expect(call({ outcome: 'already_current' })).resolves.toEqual({
            ok: true,
            value: { outcome: 'already_current' },
        });
        await expect(call({
            outcome: 'advanced',
            items: [],
            nextCursor: 'native-next',
            boundary: 'record:17',
        })).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
        await expect(call({
            outcome: 'advanced',
            items: [],
            nextCursor: 'native-next',
            boundary: 'record:17',
            diagnostics: [{
                code: 'malformed_record_skipped',
                count: 1,
                positions: [17],
            }],
        })).resolves.toMatchObject({
            ok: true,
            value: {
                outcome: 'advanced',
                items: [],
                boundary: 'record:17',
                diagnostics: [{
                    code: 'malformed_record_skipped',
                    count: 1,
                    positions: [17],
                }],
            },
        });
        await expect(call({
            outcome: 'gap_or_cursor_expired',
            items: [],
        })).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it.each([
        { hasMore: true, nextCursor: null },
        { hasMore: false, nextCursor: 'native-next-cursor' },
    ] as const)(
        'rejects contradictory paged continuation metadata before it can become a host cursor',
        async ({ hasMore, nextCursor }) => {
            const pageTranscript = vi.fn(async (_request: AgentExternalSessionsPageTranscriptRequest) => ({
                ok: true as const,
                value: {
                    items: [],
                    nextCursor,
                    hasMore,
                },
            }));
            const wrapped = createWrapper({
                contribution: {
                    ...contributionWith((method) => successFor(method)),
                    pageTranscript,
                } satisfies AgentExternalSessionsContribution,
            });

            await expect(wrapped.pageTranscript(requestFor('pageTranscript'))).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
            expect(pageTranscript).toHaveBeenCalledOnce();
        },
    );

    it('counts canonical UTF-8 bytes across the whole result envelope inclusively', async () => {
        const maximum = EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveSource.maxSerializedBytes;
        const makeResult = (padding: string) => ({
            ok: true as const,
            value: { source: { kind: 'fixture', padding } },
        });
        const baseBytes = new TextEncoder().encode(JSON.stringify(makeResult(''))).byteLength;
        const exactPadding = 'x'.repeat(maximum - baseBytes);
        const exact = createWrapper({
            contribution: contributionWith(() => makeResult(exactPadding)),
        });
        expect((await exact.resolveSource(requestFor('resolveSource'))).ok).toBe(true);

        const oversized = createWrapper({
            contribution: contributionWith(() => makeResult(`${exactPadding}🙂`)),
        });
        await expect(oversized.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it('counts strict failure envelopes and rejects oversized source input before leaf admission', async () => {
        const failure = createWrapper({
            contribution: contributionWith(() => ({
                ok: false,
                code: 'source_unreachable',
                message: 'x'.repeat(200),
                retryable: true,
            })),
        });
        await expect(failure.resolveSource({
            ...requestFor('resolveSource'),
            maxSerializedBytes: 64,
        })).resolves.toEqual({ ok: false, code: 'agent_error', retryable: false });

        const called = vi.fn();
        const oversizedSource = createWrapper({
            contribution: contributionWith((method) => {
                called(method);
                return successFor(method);
            }),
        });
        await expect(oversizedSource.resolveSource({
            ...requestFor('resolveSource'),
            source: { kind: 'fixture', padding: 'x'.repeat(EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceMaxSerializedBytes) },
        })).resolves.toEqual({ ok: false, code: 'invalid_request', retryable: false });
        expect(called).not.toHaveBeenCalled();
    });

    it.each([
        ['listCandidates', { candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1, linkData: { value: Number.NaN } }], nextCursor: null }],
        ['resolveLinkIdentity', { source, remoteSessionId: 'remote-1', linkData: { value: Number.NaN } }],
    ] as const)('rejects malformed linkData returned by %s', async (method, value) => {
        const wrapped = createWrapper({
            contribution: contributionWith(() => ({ ok: true, value })),
        });
        await expect(invoke(wrapped, method)).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it.each(['listCandidates', 'resolveLinkIdentity', 'resolveLinkedIdentity'] as const)(
        'rejects over-64KiB linkData returned by %s',
        async (method) => {
            const oversizedLinkData = { padding: 'x'.repeat(65_536) };
            const value = method === 'listCandidates'
                ? { candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1, linkData: oversizedLinkData }], nextCursor: null }
                : { source, remoteSessionId: 'remote-1', linkData: oversizedLinkData };
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({ ok: true, value })),
            });
            await expect(invoke(wrapped, method)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it('admits bounded transcript-media roots from resolved source evidence without placing them in link data', async () => {
        const transcriptMediaReadRoots = ['/tmp/external-media-one', '/tmp/external-media-two'];
        const wrapped = createWrapper({
            contribution: contributionWith((method) => {
                if (method === 'resolveSource') {
                    return {
                        ok: true,
                        value: { source, transcriptMediaReadRoots },
                    };
                }
                if (method === 'resolveLinkedIdentity') {
                    return {
                        ok: true,
                        value: {
                            source,
                            remoteSessionId: 'remote-1',
                            linkData: { key: 'value' },
                            transcriptMediaReadRoots,
                        },
                    };
                }
                return successFor(method);
            }),
        });

        await expect(wrapped.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
            ok: true,
            value: { source, transcriptMediaReadRoots },
        });
        await expect(wrapped.resolveLinkedIdentity(requestFor('resolveLinkedIdentity'))).resolves.toEqual({
            ok: true,
            value: {
                source,
                remoteSessionId: 'remote-1',
                linkData: { key: 'value' },
                transcriptMediaReadRoots,
            },
        });
    });

    it('rejects accessor, prototype, unknown-field, and non-finite output carriers', async () => {
        const accessor = {};
        Object.defineProperty(accessor, 'source', {
            enumerable: true,
            get: () => source,
        });
        const outputs: readonly unknown[] = [
            accessor,
            Object.assign(Object.create({ inherited: true }), { source }),
            { source, extra: true },
            { source: { kind: 'fixture', value: Number.POSITIVE_INFINITY } },
        ];
        for (const value of outputs) {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({ ok: true, value })),
            });
            await expect(wrapped.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        }
    });

    it.each(['resolveSource', 'listCandidates', 'resolveLinkIdentity', 'resolveLinkedIdentity', 'pageTranscript', 'readAfterTranscript'] as const)(
        'preserves a strict failure envelope from %s and rejects unknown fields',
        async (method) => {
            const valid = createWrapper({
                contribution: contributionWith(() => ({
                    ok: false,
                    code: 'source_unreachable',
                    message: 'offline',
                    retryable: true,
                })),
            });
            await expect(invoke(valid, method)).resolves.toEqual({
                ok: false,
                code: 'source_unreachable',
                message: 'offline',
                retryable: true,
            });
            const invalid = createWrapper({
                contribution: contributionWith(() => ({
                    ok: false,
                    code: 'source_unreachable',
                    retryable: true,
                    extra: true,
                }) as unknown as AgentExternalSessionsResult<unknown>),
            });
            await expect(invoke(invalid, method)).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false,
            });
        },
    );

    it('maps synchronous throws and asynchronous rejections to non-retryable agent errors', async () => {
        const sync = createWrapper({
            contribution: contributionWith(() => {
                throw new Error('sync failure');
            }),
        });
        const asyncFailure = createWrapper({
            contribution: contributionWith(async () => {
                throw new Error('async failure');
            }),
        });

        await expect(sync.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
        await expect(asyncFailure.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
        });
    });

    it('documents cooperative abort for synchronous leaf work without claiming preemption', async () => {
        const caller = new AbortController();
        const wrapped = createWrapper({
            contribution: contributionWith((method) => {
                const end = Date.now() + 5;
                while (Date.now() < end) {
                    // Synchronous plugin code cannot be preempted by AbortSignal.
                }
                return successFor(method);
            }),
        });
        setTimeout(() => caller.abort(), 0);
        await expect(wrapped.resolveSource(requestFor('resolveSource', caller.signal))).resolves.toMatchObject({ ok: true });
    });

    it('qualifies outward cursors and rejects source, generation, and method mismatches before leaf admission', async () => {
        const observed = vi.fn();
        const wrapped = createWrapper({
            contribution: contributionWith((method, request) => {
                observed(method, request);
                if (method === 'listCandidates') {
                    return { ok: true, value: { candidates: [], nextCursor: 'native-list' } };
                }
                return { ok: true, value: { items: [], nextCursor: 'native-page' } };
            }),
        });
        const first = await wrapped.listCandidates(requestFor('listCandidates'));
        if (!first.ok || first.value.nextCursor === null) throw new Error('Expected a qualified cursor');
        expect(first.value.nextCursor).not.toBe('native-list');

        const second = await wrapped.listCandidates({
            ...requestFor('listCandidates'),
            cursor: first.value.nextCursor,
        });
        expect(second.ok).toBe(true);
        expect(observed.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'native-list' });

        const reorderedSource = await wrapped.listCandidates({
            ...requestFor('listCandidates'),
            source: { root: '/tmp/sessions', kind: 'fixture' },
            cursor: first.value.nextCursor,
        });
        expect(reorderedSource.ok).toBe(true);

        const wrongSource = await wrapped.listCandidates({
            ...requestFor('listCandidates'),
            source: { kind: 'fixture', root: '/other' },
            cursor: first.value.nextCursor,
        });
        expect(wrongSource).toEqual({ ok: false, code: 'invalid_request', retryable: false });
        const wrongMethod = await wrapped.pageTranscript({
            ...requestFor('pageTranscript'),
            cursor: first.value.nextCursor,
        });
        expect(wrongMethod).toEqual({ ok: false, code: 'invalid_request', retryable: false });

        const replacement = createBoundedAgentExternalSessionsContribution({
            contribution: contributionWith((method) => successFor(method)),
            identity: { ...identity, generation: 'generation-8' },
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createInvocationExec: async () => unavailableInvocationExec,
        });
        await expect(replacement.listCandidates({
            ...requestFor('listCandidates'),
            cursor: first.value.nextCursor,
        })).resolves.toEqual({ ok: false, code: 'invalid_request', retryable: false });
        await expect(wrapped.listCandidates({
            ...requestFor('listCandidates'),
            cursor: `happier_external_cursor_v1:${'!'.repeat(20)}`,
        })).resolves.toEqual({ ok: false, code: 'invalid_request', retryable: false });
        await expect(wrapped.listCandidates({
            ...requestFor('listCandidates'),
            cursor: 'x'.repeat(EXTERNAL_SESSIONS_INVOCATION_POLICY.nativeCursorMaxCodeUnits + 1),
        })).resolves.toEqual({ ok: false, code: 'invalid_request', retryable: false });
        expect(observed).toHaveBeenCalledTimes(3);
    });

    it('admits the strict candidate-index preparation mode while qualifying its scan continuation', async () => {
        const wrapped = createWrapper({
            contribution: contributionWith((method) => method === 'listCandidates'
                ? {
                    ok: true,
                    value: {
                        candidates: [{
                            remoteSessionId: 'scan-chunk-1',
                            updatedAtMs: 10,
                            linkData: { projectId: 'project-a' },
                        }],
                        nextCursor: 'native-scan-cursor',
                        preparation: {
                            kind: 'building_candidate_index',
                            scanned: 1,
                            total: 10,
                        },
                    },
                } as AgentExternalSessionsResult<unknown>
                : successFor(method)),
        });

        const result = await wrapped.listCandidates(requestFor('listCandidates'));

        expect(result).toMatchObject({
            ok: true,
            value: {
                candidates: [expect.objectContaining({ remoteSessionId: 'scan-chunk-1' })],
                nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
                preparation: {
                    kind: 'building_candidate_index',
                    scanned: 1,
                    total: 10,
                },
            },
        });
    });

    it('qualifies a page tail cursor for readAfter and passes only its native value to the leaf', async () => {
        const observed = vi.fn();
        const wrapped = createWrapper({
            contribution: contributionWith((method, request) => {
                observed(method, request);
                return method === 'pageTranscript'
                    ? { ok: true, value: { items: [], nextCursor: null, tailCursor: 'native-tail' } }
                    : { ok: true, value: { outcome: 'already_current' } };
            }),
        });
        const page = await wrapped.pageTranscript(requestFor('pageTranscript'));
        if (!page.ok || !page.value.tailCursor) throw new Error('Expected a qualified tail cursor');
        const after = await wrapped.readAfterTranscript({
            ...requestFor('readAfterTranscript'),
            cursor: page.value.tailCursor,
        });
        expect(after.ok).toBe(true);
        expect(observed.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'native-tail' });
    });

    it('admits a provenance-pinned released native cursor and writes the continuation forward as host-qualified', async () => {
        const observed = vi.fn();
        const wrapped = createWrapper({
            contribution: contributionWith((method, request) => {
                observed(method, request);
                return method === 'readAfterTranscript'
                    ? {
                        ok: true,
                        value: {
                            outcome: 'advanced',
                            items: [{ id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw }],
                            nextCursor: 'native-current-continuation',
                            boundary: 'item-1',
                        },
                    }
                    : successFor(method);
            }),
        });
        // Exact forward v3 cursor from cli-v0.2.1
        // (b1d15a8a9c241737d1ca9b167459901e6259173a) and
        // cli-v0.2.2-preview.1775586717.26498
        // (4913c1e533c872a0712ba1c25b3104fd470aacc2).
        const releasedNativeCursor = 'eyJ2IjozLCJraW5kIjoiY29kZXhGb3J3YXJkTWVyZ2VkIiwibGFzdENyZWF0ZWRBdE1zIjoxNzcxNDAzMjg1MDAwLCJsYXN0SWQiOiJjb2RleDpzZXNzaW9ucy8yMDI2LzAyLzE4L3JvbGxvdXQtMjAyNi0wMi0xOFQwOC0yOC0wNS01NTU1NTU1NS01NTU1LTU1NTUtNTU1NS01NTU1NTU1NTU1NTUuanNvbmw6MDAwMDAwMDAwMDAwOjAwMCJ9';

        const result = await wrapped.readAfterTranscript({
            ...requestFor('readAfterTranscript'),
            cursor: releasedNativeCursor,
        });

        expect(observed).toHaveBeenLastCalledWith(
            'readAfterTranscript',
            expect.objectContaining({ cursor: releasedNativeCursor }),
        );
        expect(result).toMatchObject({
            ok: true,
            value: {
                outcome: 'advanced',
                nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/),
            },
        });
    });
});

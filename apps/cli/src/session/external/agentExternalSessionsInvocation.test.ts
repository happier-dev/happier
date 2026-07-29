import { describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionSource,
    AgentExternalSessionsContribution,
    AgentExternalSessionsListCandidatesRequest,
    AgentExternalSessionsPageTranscriptRequest,
    AgentExternalSessionsReadAfterTranscriptRequest,
    AgentExternalSessionsResolveLinkedIdentityRequest,
    AgentExternalSessionsResolveLinkIdentityRequest,
    AgentExternalSessionsResolveSourceRequest,
    AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
    createBoundedAgentExternalSessionsContribution,
} from './agentExternalSessionsInvocation';

const identity = Object.freeze({
    pluginId: 'acme.external',
    agentId: 'acme-agent',
    generation: 'generation-7',
});
const source = Object.freeze({ kind: 'fixture', root: '/tmp/sessions' });

type MethodName = keyof AgentExternalSessionsContribution;

function requestFor(method: 'resolveSource', signal?: AbortSignal): AgentExternalSessionsResolveSourceRequest;
function requestFor(method: 'listCandidates', signal?: AbortSignal): AgentExternalSessionsListCandidatesRequest;
function requestFor(method: 'resolveLinkIdentity', signal?: AbortSignal): AgentExternalSessionsResolveLinkIdentityRequest;
function requestFor(method: 'resolveLinkedIdentity', signal?: AbortSignal): AgentExternalSessionsResolveLinkedIdentityRequest;
function requestFor(method: 'pageTranscript', signal?: AbortSignal): AgentExternalSessionsPageTranscriptRequest;
function requestFor(method: 'readAfterTranscript', signal?: AbortSignal): AgentExternalSessionsReadAfterTranscriptRequest;
function requestFor(
    method: MethodName,
    signal = new AbortController().signal,
): AgentExternalSessionsResolveSourceRequest
    | AgentExternalSessionsListCandidatesRequest
    | AgentExternalSessionsResolveLinkIdentityRequest
    | AgentExternalSessionsResolveLinkedIdentityRequest
    | AgentExternalSessionsPageTranscriptRequest
    | AgentExternalSessionsReadAfterTranscriptRequest {
    const invocation = { signal, deadlineAtMs: Number.MAX_SAFE_INTEGER, maxSerializedBytes: Number.MAX_SAFE_INTEGER };
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

function contributionWith(
    implementation: (method: MethodName, request: unknown) => AgentExternalSessionsResult<unknown> | Promise<AgentExternalSessionsResult<unknown>>,
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
    contribution: AgentExternalSessionsContribution,
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
}>) {
    return createBoundedAgentExternalSessionsContribution({
        contribution: params?.contribution ?? contributionWith((method) => successFor(method)),
        identity,
        isCurrent: params?.isCurrent ?? (() => true),
        retirementSignal: params?.retirementSignal ?? new AbortController().signal,
    });
}

describe('bounded Agent External Sessions invocation', () => {
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
        const called = vi.fn(() => pending.promise);
        const wrapped = createWrapper({
            contribution: contributionWith(called),
            isCurrent: () => current,
            retirementSignal: retirement.signal,
        });

        const cancelledResult = wrapped.resolveSource(requestFor('resolveSource', caller.signal));
        await Promise.resolve();
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
            : { id: 'item-1', createdAtMs: 1, raw: {} };
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
        const item = { id: 'item-1', createdAtMs: 1, raw: {} };
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
        ['pageTranscript', { items: [{ id: 'item-1', createdAtMs: 1, raw: { value: Number.NaN } }], nextCursor: null }],
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

    it.each(['listCandidates', 'resolveLinkIdentity', 'resolveLinkedIdentity', 'pageTranscript'] as const)(
        'rejects over-64KiB linkData returned by %s',
        async (method) => {
            const oversizedLinkData = { padding: 'x'.repeat(65_536) };
            const value = method === 'listCandidates'
                ? { candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1, linkData: oversizedLinkData }], nextCursor: null }
                : method === 'pageTranscript'
                    ? { items: [{ id: 'item-1', createdAtMs: 1, raw: oversizedLinkData }], nextCursor: null }
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
                            items: [{ id: 'item-1', createdAtMs: 1, raw: {} }],
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

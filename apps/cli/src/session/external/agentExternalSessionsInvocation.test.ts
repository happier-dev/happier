import { describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
    AgentExternalSessionsManagedEndpointReadResponse,
    AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionSource,
    AgentExternalSessionCandidate,
    AgentExternalSessionsListCandidatesRequest,
    AgentExternalSessionsPageTranscriptRequest,
    AgentExternalSessionsReadAfterTranscriptRequest,
    AgentExternalSessionsResolveLinkedIdentityRequest,
    AgentExternalSessionsResolveLinkIdentityRequest,
    AgentExternalSessionsResolveSourceRequest,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS,
    MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
} from '@happier-dev/protocol';

import {
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
    createBoundedAgentExternalSessionsContribution,
    type BoundedAgentExternalSessionsContribution,
} from './agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import * as packagedRipgrep from '@/integrations/ripgrep';

const identity = Object.freeze({
    pluginId: 'acme.external',
    agentId: 'acme-agent',
    occurrenceId: 'occurrence-7',
    contributionQualifiedId: 'acme.external/agents/acme-agent',
    sourceCustody: Object.freeze({
        kind: 'development' as const,
        registeredRootId: 'test-source-root',
    }),
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
        deadlineAtMs: Date.now() + 60_000,
        maxSerializedBytes: method === 'listCandidates' ? 1_048_576
            : method === 'pageTranscript' || method === 'readAfterTranscript' ? 524_288 : 262_144,
    };
    switch (method) {
        case 'resolveSource':
            return { ...invocation, source };
        case 'listCandidates':
            return { ...invocation, source, cursor: undefined, maxItems: 50, searchTerm: 'needle', searchMode: 'fast' as const };
        case 'resolveLinkIdentity':
            return { ...invocation, source, remoteSessionId: 'remote-1', linkData: { key: 'value' } };
        case 'resolveLinkedIdentity':
            return { ...invocation, source, remoteSessionId: 'remote-1', linkData: { key: 'value' } };
        case 'pageTranscript':
            return { ...invocation, source, remoteSessionId: 'remote-1', direction: 'older' as const, maxItems: 200 };
        case 'readAfterTranscript':
            return { ...invocation, source, remoteSessionId: 'remote-1', cursor: 'leaf-cursor', maxItems: 200 };
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

it('admits bounded source diagnostics on a truncated transcript page without accepting extra diagnostic fields', async () => {
    const diagnostic = { code: 'external_sessions_source_identity_changed', severity: 'required', count: 1, positions: [] };
    const wrapped = createWrapper({ contribution: contributionWith(() => ({ ok: true,
        value: { items: [], nextCursor: null, truncated: true, diagnostics: [diagnostic] } })) });
    await expect(wrapped.pageTranscript(requestFor('pageTranscript'))).resolves.toMatchObject({
        ok: true, value: { truncated: true, diagnostics: [diagnostic] },
    });
    const rejected = createWrapper({ contribution: contributionWith(() => ({ ok: true,
        value: { items: [], nextCursor: null, diagnostics: [{ ...diagnostic, privatePath: '/private' }] } })) });
    await expect(rejected.pageTranscript(requestFor('pageTranscript'))).resolves.toMatchObject({ ok: false, code: 'agent_error' });
});

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
    it.each([
        [{ items: {}, nextCursor: null }, 'transcript_page_envelope'],
        [{ items: [{ id: 'bad', createdAtMs: 0, raw: {} }], nextCursor: null }, 'transcript_page_item'],
        [{ items: [], nextCursor: null, hasMore: true }, 'transcript_page_continuation'],
        [{ items: [], nextCursor: null, diagnostics: [{ code: 'bad', severity: 'other' }] }, 'transcript_page_diagnostics'],
    ] as const)('names the rejecting strict transcript-page branch', async (value, reason) => {
        const wrapped = createWrapper({ contribution: contributionWith(() => ({ ok: true, value })) });
        await expect(wrapped.pageTranscript(requestFor('pageTranscript'))).resolves.toMatchObject({
            ok: false, code: 'agent_error', message: `external_sessions_${reason}`,
        });
    });
    it('admits source-wide accounting through the existing services and rejects transcript data', async () => {
        const observations = [{ nativeSessionId: 'native-1', observedAt: 10,
            observation: { provider: 'fixture', source: 'native', scope: 'turn_delta' as const,
                key: null, modelId: null, tokens: { input: 3, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: null,
                contextUsedTokens: null, contextWindowTokens: null } }];
        const contribution = {
            ...contributionWith((method) => successFor(method)),
            readAccounting: async (request: Readonly<{ source: AgentExternalSessionSource; cursor?: string; exec: unknown; managedEndpointRead: unknown }>) => {
                expect(request.source).toEqual(source);
                expect(request.cursor).toBe('native-frontier');
                expect(request.exec).toBe(unavailableInvocationExec);
                expect(request.managedEndpointRead).toEqual(expect.any(Function));
                return { ok: true as const, value: { outcome: 'advanced' as const, observations, nextCursor: 'next-frontier', coverage: { complete: true } } };
            },
        };
        const wrapped = createWrapper({ contribution });
        await expect(wrapped.readAccounting!({ source, cursor: 'native-frontier', signal: new AbortController().signal })).resolves.toEqual({
            ok: true, value: { outcome: 'advanced', observations, nextCursor: 'next-frontier', coverage: { complete: true } },
        });
        const malformed = createWrapper({ contribution: {
            ...contribution,
            readAccounting: async () => ({ ok: true, value: { outcome: 'advanced', observations: [], nextCursor: 'next', coverage: { complete: true }, transcript: 'private text' } }),
        } });
        await expect(malformed.readAccounting!({ source, signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'agent_error' });
    });

    it('retains an operation exception class without its private message', async () => {
        const wrapped = createWrapper({ contribution: contributionWith(() => {
            throw new TypeError('/private/native-file: transcript-secret');
        }) });
        await expect(wrapped.listCandidates(requestFor('listCandidates'))).resolves.toEqual({
            ok: false, code: 'agent_error', retryable: false,
            message: 'external_sessions_operation_type_error',
        });
    });

    it('explains cursor admission failure without disclosing the native cursor', async () => {
        const wrapped = createWrapper({ contribution: contributionWith(method => method === 'pageTranscript'
            ? { ok: true, value: { items: [], nextCursor: 'private-native-state' + 'x'.repeat(
                EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes,
            ) } }
            : successFor(method)) });
        await expect(wrapped.pageTranscript(requestFor('pageTranscript'))).resolves.toEqual({
            ok: false, code: 'agent_error', retryable: false,
            message: 'external_sessions_transcript_page_byte_budget',
        });
    });

    it('round-trips a candidate continuation larger than the transcript cursor limit within its reply budget', async () => {
        const cursor = 'native-discovery-facts'.repeat(300);
        const seen: string[] = [];
        const wrapped = createWrapper({ contribution: contributionWith((method, request) => {
            if (method !== 'listCandidates') return successFor(method);
            const inputCursor = 'cursor' in request ? request.cursor : undefined;
            if (typeof inputCursor === 'string') seen.push(inputCursor);
            return { ok: true, value: { candidates: [], nextCursor: inputCursor ? null : cursor } };
        }) });
        const first = await wrapped.listCandidates(requestFor('listCandidates'));
        expect(first).toMatchObject({ ok: true, value: { nextCursor: expect.stringMatching(/^happier_external_cursor_v1:/) } });
        if (!first.ok || !first.value.nextCursor) throw new Error('Expected a resumable candidate page');
        expect(JSON.stringify(first).length).toBeLessThan(EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes);
        await expect(wrapped.listCandidates({ ...requestFor('listCandidates'), cursor: first.value.nextCursor }))
            .resolves.toMatchObject({ ok: true, value: { candidates: [], nextCursor: null } });
        expect(seen).toEqual([cursor]);
        const bounded = createWrapper({ contribution: contributionWith(() => ({ ok: true, value: { candidates: [], nextCursor: cursor } })) });
        const bytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
        await expect(bounded.listCandidates({ ...requestFor('listCandidates'), maxSerializedBytes: bytes }))
            .resolves.toEqual(first);
        await expect(bounded.listCandidates({ ...requestFor('listCandidates'), maxSerializedBytes: bytes - 1 }))
            .resolves.toMatchObject({ ok: false, code: 'agent_error', message: 'external_sessions_result_byte_budget' });
        await expect(wrapped.listCandidates({ ...requestFor('listCandidates'),
            cursor: 'x'.repeat(EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes + 1) }))
            .resolves.toMatchObject({ ok: false, code: 'invalid_request' });
        expect(seen).toEqual([cursor]);
    });

    it.each([false, true])('preserves caller deadline cancellation before admission=%s', async beforeAdmission => {
        const caller = new AbortController();
        const deadline = () => caller.abort(Object.assign(new Error('private timeout detail'), { code: 'RPC_REQUEST_TIMEOUT' }));
        if (beforeAdmission) deadline();
        const wrapped = createWrapper({ contribution: contributionWith(method => {
            deadline();
            return successFor(method);
        }) });
        await expect(wrapped.listCandidates(requestFor('listCandidates', caller.signal)))
            .resolves.toMatchObject({ ok: false, code: 'timeout', retryable: true });
    });

    it('reports older accounting facets unsupported and fences cancelled or retired accounting', async () => {
        const older = createWrapper();
        expect(older.supportsAccounting).toBe(false);
        await expect(older.readAccounting!({ source, signal: new AbortController().signal })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
        const pending = deferred<AgentExternalSessionsResult<{ outcome: 'unchanged' }>>();
        const retirement = new AbortController();
        const caller = new AbortController();
        const wrapped = createWrapper({ retirementSignal: retirement.signal, contribution: {
            ...contributionWith((method) => successFor(method)),
            readAccounting: async () => pending.promise,
        } });
        const cancelled = wrapped.readAccounting!({ source, signal: caller.signal });
        expect(wrapped.supportsAccounting).toBe(true);
        caller.abort();
        await expect(cancelled).resolves.toMatchObject({ ok: false, code: 'cancelled' });
        const retired = wrapped.readAccounting!({ source, signal: new AbortController().signal });
        retirement.abort();
        await expect(retired).resolves.toMatchObject({ ok: false, code: 'unavailable' });
        pending.resolve({ ok: true, value: { outcome: 'unchanged' } });
    });
    it('preserves a caller deadline beyond the native timer range and cancels its rearmed timer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const pending = deferred<AgentExternalSessionsResult<unknown>>();
            const wrapped = createWrapper({ contribution: contributionWith(() => pending.promise) });
            const result = wrapped.resolveSource({ ...requestFor('resolveSource'), deadlineAtMs: Date.now() + 2_147_483_647 + 2_000 });
            await vi.advanceTimersByTimeAsync(2_147_483_647 + 1_000);
            pending.resolve(successFor('resolveSource'));
            await expect(result).resolves.toEqual(successFor('resolveSource'));
            expect(vi.getTimerCount()).toBe(0);

            const caller = new AbortController();
            const cancelled = wrapped.resolveSource({ ...requestFor('resolveSource', caller.signal), deadlineAtMs: Date.now() + 2_147_483_647 + 2_000 });
            caller.abort();
            await expect(cancelled).resolves.toMatchObject({ ok: false, code: 'cancelled' });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets a valid contribution settle beyond fifteen seconds within its caller deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const pending = deferred<AgentExternalSessionsResult<unknown>>();
            const wrapped = createWrapper({ contribution: contributionWith(() => pending.promise) });
            const result = wrapped.resolveSource({ ...requestFor('resolveSource'), deadlineAtMs: 61_000 });
            await vi.advanceTimersByTimeAsync(46_000);
            pending.resolve(successFor('resolveSource'));
            await expect(result).resolves.toEqual(successFor('resolveSource'));
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves an explicitly requested candidate page above the old fifty-item cap', async () => {
        const candidates = Array.from({ length: 75 }, (_, index) => ({ remoteSessionId: `remote-${index}`, updatedAtMs: index }));
        const wrapped = createWrapper({ contribution: contributionWith(() => ({ ok: true, value: { candidates, nextCursor: null } })) });
        await expect(wrapped.listCandidates({ ...requestFor('listCandidates'), maxItems: 75, maxSerializedBytes: 2_097_152 })).resolves.toMatchObject({ ok: true, value: { candidates } });
    });

    it('admits valid transcript content above the old host cap within the caller byte budget', async () => {
        const items = [{ id: 'large-message', createdAtMs: 1, raw: { role: 'user' as const, content: { type: 'text' as const, text: 'x'.repeat(600_000) } } }];
        const wrapped = createWrapper({ contribution: contributionWith(() => ({ ok: true, value: { items, nextCursor: null } })) });
        await expect(wrapped.pageTranscript({ ...requestFor('pageTranscript'), maxSerializedBytes: 1_048_576 })).resolves.toMatchObject({ ok: true, value: { items } });
    });

    it.each(['pageTranscript', 'readAfterTranscript'] as const)(
        'repages %s within the caller budget after qualifying native cursors without losing rows', async (method) => {
            const maxSerializedBytes = 2_048;
            const wrapped = createWrapper({ contribution: contributionWith((_method, request) => {
                const cursor = 'cursor' in request ? request.cursor : undefined;
                const start = cursor ? Number(cursor.split(':')[0]) : 0;
                const rows: unknown[] = [];
                const resultFor = (items: unknown[]) => {
                    const next = start + items.length;
                    const hasMore = next < 30;
                    const nextCursor = `${next}:${'x'.repeat(100)}`;
                    return { ok: true, value: method === 'pageTranscript'
                        ? { items, nextCursor: hasMore ? nextCursor : null, tailCursor: 'native-tail', hasMore }
                        : { outcome: 'advanced', items, nextCursor, boundary: `item-${next}`, hasMore } };
                };
                for (let index = start; index < 30; index += 1) {
                    const row = { id: `item-${index}`, createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: '🙂'.repeat(30) } } };
                    if (Buffer.byteLength(JSON.stringify(resultFor([...rows, row]))) > request.maxSerializedBytes!) break;
                    rows.push(row);
                }
                return resultFor(rows) as AgentExternalSessionsResult<unknown>;
            }) });
            const ids: string[] = [];
            let cursor: string | undefined = method === 'readAfterTranscript' ? '0:start' : undefined;
            do {
                const result = method === 'pageTranscript'
                    ? await wrapped.pageTranscript({ ...requestFor(method), maxSerializedBytes, cursor })
                    : await wrapped.readAfterTranscript({ ...requestFor(method), maxSerializedBytes, cursor: cursor! });
                expect(result).toMatchObject({ ok: true });
                expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(maxSerializedBytes);
                if (!result.ok) throw new Error('Expected a bounded page');
                const value = result.value;
                const rows = 'items' in value ? value.items : [];
                expect(rows.length).toBeGreaterThan(0);
                ids.push(...rows.map(row => row.id));
                cursor = 'hasMore' in value && value.hasMore === false ? undefined : 'nextCursor' in value ? value.nextCursor ?? undefined : undefined;
            } while (cursor && ids.length <= 30);
            expect(ids).toEqual(Array.from({ length: 30 }, (_, index) => `item-${index}`));
        },
    );

    it('runs packaged ripgrep on the source file set and cancels it with the invocation', async () => {
        const started = deferred<AbortSignal>();
        const run = vi.spyOn(packagedRipgrep, 'run').mockImplementation(async (_args, options) => {
            const signal = options!.signal!;
            started.resolve(signal);
            return await new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        const caller = new AbortController();
        const wrapped = createWrapper({ contribution: contributionWith(async (_method, request) => {
            await request.ripgrep.run({ args: ['--files-with-matches', '--fixed-strings', '--', 'body phrase'], paths: ['/source/session.jsonl'] });
            return successFor('listCandidates');
        }) });
        const pending = wrapped.listCandidates(requestFor('listCandidates', caller.signal));
        try {
            const processSignal = await Promise.race([started.promise, (async () => {
                const result = await pending;
                expect(result.ok).toBe(true);
                throw new Error('Contribution settled before packaged ripgrep started');
            })()]);
            expect(run.mock.calls[0]?.[0]).toEqual(['--files-with-matches', '--fixed-strings', '--', 'body phrase']);
            expect(run.mock.calls[0]?.[1]).toMatchObject({ paths: ['/source/session.jsonl'], maxStdoutBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes, terminateOnStdoutLimit: true });
            caller.abort();
            await expect(pending).resolves.toMatchObject({ ok: false, code: 'cancelled' });
            expect(processSignal.aborted).toBe(true);
        } finally {
            caller.abort();
            run.mockRestore();
        }
    });
    it('admits content matches and partial coverage through the generation-bound producer boundary', async () => {
        const searchTerm = '  literal body  ';
        const match = { snippet: 'decoded body phrase', sourceItemId: 'source-item', messageIndex: 3 };
        const wrapped = createWrapper({ contribution: contributionWith((_method, request) => {
            expect(request).toMatchObject({ searchTarget: 'content', searchTerm });
            return { ok: true, value: { candidates: [{ remoteSessionId: 'remote', updatedAtMs: 1, match }], nextCursor: null, contentCoverage: 'partial' } };
        }) });
        await expect(wrapped.listCandidates({ ...requestFor('listCandidates'), searchTarget: 'content', searchTerm })).resolves.toEqual({
            ok: true, value: { candidates: [{ remoteSessionId: 'remote', updatedAtMs: 1, match }], nextCursor: null, contentCoverage: 'partial' },
        });
    });
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
            deadlineAtMs: Date.now() + 60_000,
            maxSerializedBytes: 1_048_576,
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

    it('rejects a whitespace-only candidate title at the canonical Agent result parser', async () => {
        const wrapped = createWrapper({
            contribution: contributionWith(() => ({
                ok: true,
                value: {
                    candidates: [{
                        remoteSessionId: 'remote-1',
                        updatedAtMs: 1,
                        title: '   \n\t ',
                    }],
                    nextCursor: null,
                },
            })),
        });

        await expect(wrapped.listCandidates(requestFor('listCandidates'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
    });

    it('round-trips private candidate index state through the bounded Agent boundary', async () => {
        const priorState = Object.freeze({ kind: 'fixture-index', offset: 41 });
        const wrapped = createWrapper({
            contribution: contributionWith((_method, request) => {
                const listRequest = request as AgentExternalSessionsListCandidatesRequest;
                const candidateIndexState = listRequest.readCandidateIndexState?.({
                    remoteSessionId: 'remote-1',
                    linkData: { projectId: 'project-a' },
                });
                return {
                    ok: true,
                    value: {
                        candidates: [{
                            remoteSessionId: 'remote-1',
                            updatedAtMs: 1,
                            linkData: { projectId: 'project-a' },
                            candidateIndexState,
                        }],
                        nextCursor: null,
                    },
                };
            }),
        });

        await expect(wrapped.listCandidates({
            ...requestFor('listCandidates'),
            readCandidateIndexState: () => priorState,
        })).resolves.toMatchObject({
            ok: true,
            value: {
                candidates: [{ candidateIndexState: priorState }],
            },
        });
    });

    it('forwards the thread-listing opt-in and admits only a well-formed candidate thread marker', async () => {
        const observed: AgentExternalSessionsListCandidatesRequest[] = [];
        const thread = { kind: 'reviewer', parentRemoteSessionId: 'parent-1' } as const;
        let returnedThread: unknown = thread;
        const wrapped = createWrapper({
            contribution: contributionWith((_method, request) => {
                observed.push(request as AgentExternalSessionsListCandidatesRequest);
                return {
                    ok: true,
                    value: {
                        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1, thread: returnedThread }],
                        nextCursor: null,
                    },
                };
            }),
        });

        await expect(wrapped.listCandidates({
            ...requestFor('listCandidates'),
            includeThreads: true,
        })).resolves.toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'remote-1', thread }] } });
        expect(observed[0]?.includeThreads).toBe(true);

        await wrapped.listCandidates(requestFor('listCandidates'));
        expect(observed[1]).not.toHaveProperty('includeThreads');

        await expect(wrapped.listCandidates({
            ...requestFor('listCandidates'),
            includeThreads: 'yes' as unknown as boolean,
        })).resolves.toMatchObject({ ok: false, code: 'invalid_request' });

        returnedThread = { kind: 'fork', parentRemoteSessionId: null };
        await expect(wrapped.listCandidates(requestFor('listCandidates'))).resolves.toMatchObject({
            ok: false,
            code: 'agent_error',
        });
    });

    it.each([
        ['resolveSource', 262_144, undefined],
        ['listCandidates', 1_048_576, 50],
        ['resolveLinkIdentity', 262_144, undefined],
        ['resolveLinkedIdentity', 262_144, undefined],
        ['pageTranscript', 524_288, 200],
        ['readAfterTranscript', 524_288, 200],
    ] as const)('preserves the caller operation budget for %s', async (method, maxSerializedBytes, maxItems) => {
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
            deadlineAtMs: 61_000,
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

        const resultPromise = wrapped.resolveSource({ ...requestFor('resolveSource', caller.signal), deadlineAtMs: Date.now() + 60_000 });
        await vi.advanceTimersByTimeAsync(60_000);
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
        await vi.advanceTimersByTimeAsync(60_000);
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
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
    });

    it('accepts exactly-max readAfter items and rejects max-plus-one', async () => {
        const maximum = EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems;
        const item = { id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw };
        const value = (count: number) => ({
            outcome: 'advanced',
            hasMore: false,
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
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
    });

    it('applies the canonical transcript item identity bound at the Agent wrapper', async () => {
        const page = (id: string) => ({
            ok: true as const,
            value: { items: [{ id, createdAtMs: 1, raw: canonicalTranscriptRaw }], nextCursor: null },
        });
        const exact = 'x'.repeat(2_000);
        const accepted = createWrapper({ contribution: contributionWith(() => page(exact)) });
        const acceptedResult = await accepted.pageTranscript(requestFor('pageTranscript'));
        expect(acceptedResult.ok
            && (acceptedResult.value as { items: readonly { id: string }[] }).items[0]?.id)
            .toBe(exact);

        for (const id of ['x'.repeat(2_001), ` ${'x'.repeat(10)} `, '']) {
            const rejected = createWrapper({ contribution: contributionWith(() => page(id)) });
            await expect(rejected.pageTranscript(requestFor('pageTranscript'))).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
        }
    });

    it('admits a deeply nested canonical transcript result under the serialized byte ceiling', async () => {
        // The canonical schema deliberately carries no generic depth quota, so result
        // sizing must not reintroduce one through recursive serialization.
        let output: unknown = 'leaf';
        for (let depth = 0; depth < 7_000; depth += 1) output = { nested: output };
        const item = {
            id: 'item-deep',
            createdAtMs: 1,
            raw: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'tool-call-result', callId: 'call-1', output } },
            },
        };
        const wrapped = createWrapper({
            contribution: contributionWith(() => ({ ok: true, value: { items: [item], nextCursor: null } })),
        });

        const result = await wrapped.pageTranscript(requestFor('pageTranscript'));

        expect(result).toMatchObject({ ok: true });
        expect(result.ok && (result.value as { items: readonly { id: string }[] }).items[0]?.id).toBe('item-deep');
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
            const call = async (value: string | null) => {
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
                                hasMore: false,
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
            await expect(call(null)).resolves.toMatchObject(field === 'localId'
                ? { ok: true, value: { items: [{ localId: null }] } }
                : { ok: false, code: 'agent_error' });
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
                                hasMore: false,
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
            await expect(call('')).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
        },
    );

    it('admits ordered native observations only for an explicit terminal source projection', async () => {
        const item = {
            id: 'native-line-1', createdAtMs: 1,
            raw: { role: 'source_observation', content: { type: 'queue-operation', operation: 'enqueue' } },
        };
        const wrapped = createWrapper({ contribution: contributionWith((method) => ({
            ok: true,
            value: method === 'pageTranscript'
                ? { items: [item], nextCursor: null }
                : { outcome: 'advanced', items: [item], nextCursor: 'native-next', boundary: item.id, hasMore: false },
        })) });
        await expect(wrapped.readAfterTranscript({
            ...requestFor('readAfterTranscript'), projection: 'terminal',
        })).resolves.toMatchObject({ ok: true, value: { items: [item] } });
        await expect(wrapped.readAfterTranscript(requestFor('readAfterTranscript')))
            .resolves.toMatchObject({ ok: false, code: 'agent_error' });
        await expect(wrapped.pageTranscript(requestFor('pageTranscript')))
            .resolves.toMatchObject({ ok: false, code: 'agent_error' });
        await expect(wrapped.pageTranscript({
            ...requestFor('pageTranscript'), projection: 'terminal', direction: 'newer',
        })).resolves.toMatchObject({ ok: true, value: { items: [item] } });
    });

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
                            hasMore: false,
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                    retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
                });
                await expect(callWithRaw('readAfterTranscript', raw)).resolves.toEqual({
                    ok: false,
                    code: 'agent_error',
                    retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
        });

        it('admits transcript records beyond the removed depth and node quotas', async () => {
            let output: unknown = 'leaf';
            for (let depth = 0; depth < 32; depth += 1) output = { nested: output };
            const wideOutput = Array.from({ length: 8_300 }, () => null);
            for (const admittedOutput of [output, wideOutput]) await expect(callWithRaw('pageTranscript', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'call-1',
                        id: 'tool-1',
                        output: admittedOutput,
                    },
                },
            })).resolves.toMatchObject({
                ok: true,
                value: { items: [{ raw: { role: 'agent' } }] },
            });
        });

        it('accepts structural transcript DTOs and rejects cyclic or non-finite broadened data', async () => {
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
            const accepted: readonly (readonly [string, unknown])[] = [
                ['accessor-backed', accessor],
                ['custom-prototype', Object.assign(Object.create({ inherited: true }), {
                    role: 'user',
                    content: { type: 'text', text: 'x' },
                })],
            ];
            for (const [representation, raw] of accepted) {
                await expect(callWithRaw('pageTranscript', raw), representation).resolves.toMatchObject({
                    ok: true,
                    value: { items: [{ raw: { role: 'user' } }] },
                });
            }
            const rejected: readonly unknown[] = [
                cyclic,
                { role: 'user', content: { type: 'text', text: 'x' }, ordinal: Number.NaN },
            ];
            for (const raw of rejected) {
                await expect(callWithRaw('pageTranscript', raw)).resolves.toEqual({
                    ok: false,
                    code: 'agent_error',
                    retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
                });
            }
        });
    });

    it.each([
        ['read-after boundary', 2_000, (value: string) => ({ boundary: value })],
        ['read-after diagnostic code', 128, (value: string) => ({
            boundary: 'item-1',
            diagnostics: [{ code: value, severity: 'benign', count: 1, positions: [0] }],
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
                            hasMore: false,
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
    });

    it.each([
        ['pageTranscript', 'nextCursor'],
        ['pageTranscript', 'tailCursor'],
        ['readAfterTranscript', 'nextCursor'],
    ] as const)(
        'admits semantic %s %s cursors within the whole qualified response budget',
        async (method, field) => {
            const cursor = 'native-semantic-facts'.repeat(30_000);
            const maxSerializedBytes = EXTERNAL_SESSIONS_INVOCATION_POLICY[method].maxSerializedBytes * 2;
            const call = async (cursor: string) => {
                const wrapped = createWrapper({
                    contribution: contributionWith(() => ({
                        ok: true,
                        value: method === 'pageTranscript'
                                ? { items: [], nextCursor: null, [field]: cursor }
                                : {
                                    outcome: 'advanced',
                                    hasMore: false,
                                    items: [{ id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw }],
                                    nextCursor: cursor,
                                    boundary: 'item-1',
                                },
                    })),
                });
                return method === 'pageTranscript'
                    ? await wrapped.pageTranscript({ ...requestFor(method), maxSerializedBytes })
                    : await wrapped.readAfterTranscript({ ...requestFor(method), maxSerializedBytes });
            };

            const first = await call(cursor);
            expect(first).toMatchObject({
                ok: true,
                value: { [field]: expect.stringMatching(/^happier_external_cursor_v1:/) },
            });
            const bytes = Buffer.byteLength(JSON.stringify(first), 'utf8');
            // Exercise the actual resource boundary, including qualification
            // overhead, rather than a second arbitrary native-cursor ceiling.
            const bounded = createWrapper({ contribution: contributionWith(() => ({ ok: true,
                value: method === 'pageTranscript' ? { items: [], nextCursor: null, [field]: cursor }
                    : { outcome: 'advanced', hasMore: false,
                        items: [{ id: 'item-1', createdAtMs: 1, raw: canonicalTranscriptRaw }], nextCursor: cursor, boundary: 'item-1' },
            })) });
            const withBytes = (maxSerializedBytes: number) => method === 'pageTranscript'
                ? bounded.pageTranscript({ ...requestFor(method), maxSerializedBytes })
                : bounded.readAfterTranscript({ ...requestFor(method), maxSerializedBytes });
            await expect(withBytes(bytes)).resolves.toEqual(first);
            await expect(withBytes(bytes - 1)).resolves.toMatchObject({ ok: false, code: 'agent_error',
                message: 'external_sessions_transcript_page_byte_budget' });
        },
    );

    it.each(['pageTranscript', 'readAfterTranscript'] as const)(
        'uses the %s response resource budget for coarse opaque input admission',
        async (method) => {
            const maxSerializedBytes = EXTERNAL_SESSIONS_INVOCATION_POLICY[method].maxSerializedBytes * 2;
            const exact = exactOpaqueCodeUnits(maxSerializedBytes);
            const observed = vi.fn();
            const wrapped = createWrapper({
                contribution: contributionWith((calledMethod, request) => {
                    observed(calledMethod, request);
                    return successFor(calledMethod);
                }),
            });
            const call = async (cursor: string) => method === 'pageTranscript'
                    ? await wrapped.pageTranscript({ ...requestFor('pageTranscript'), cursor, maxSerializedBytes })
                    : await wrapped.readAfterTranscript({ ...requestFor('readAfterTranscript'), cursor, maxSerializedBytes });

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
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
        await expect(call({ outcome: 'already_current' })).resolves.toEqual({
            ok: true,
            value: { outcome: 'already_current' },
        });
        await expect(call({
            outcome: 'advanced',
            hasMore: false,
            items: [],
            nextCursor: 'native-next',
            boundary: 'record:17',
        })).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
        await expect(call({
            outcome: 'advanced',
            hasMore: false,
            items: [],
            nextCursor: 'native-next',
            boundary: 'record:17',
            diagnostics: [{
                code: 'malformed_record_skipped',
                severity: 'benign',
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
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
            expect(pageTranscript).toHaveBeenCalledOnce();
        },
    );

    it('counts canonical UTF-8 bytes across the whole result envelope inclusively', async () => {
        // The caller-supplied budget is the binding ceiling here: Protocol caps
        // a source itself at 64 KiB, so the resolveSource envelope ceiling can
        // no longer be reached by padding the source. Clamping the request to a
        // small budget still proves the count is whole-envelope, inclusive and
        // measured in UTF-8 bytes rather than code units.
        const maximum = 4_096;
        const makeResult = (padding: string) => ({
            ok: true as const,
            value: { source: { kind: 'fixture', padding } },
        });
        const baseBytes = new TextEncoder().encode(JSON.stringify(makeResult(''))).byteLength;
        const exactPadding = 'x'.repeat(maximum - baseBytes);
        const exact = createWrapper({
            contribution: contributionWith(() => makeResult(exactPadding)),
        });
        expect((await exact.resolveSource({
            ...requestFor('resolveSource'),
            maxSerializedBytes: maximum,
        })).ok).toBe(true);

        const oversized = createWrapper({
            contribution: contributionWith(() => makeResult(`${exactPadding}🙂`)),
        });
        await expect(oversized.resolveSource({
            ...requestFor('resolveSource'),
            maxSerializedBytes: maximum,
        })).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
    });

    it('admits contribution sources only through the canonical Protocol source parser', async () => {
        // The wrapper must not restate source limits. Protocol owns the kind
        // bound, the already-trimmed kind rule and the serialized-byte budget;
        // a second grammar here silently disagreed with every other reader.
        expect(EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceKindMaxCodeUnits)
            .toBe(MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS);
        expect(EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceMaxSerializedBytes)
            .toBe(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES);

        for (const kind of [
            'x'.repeat(MAX_EXTERNAL_SESSIONS_SOURCE_KIND_CODE_UNITS + 1),
            ' fixture',
            'fixture ',
        ]) {
            const called = vi.fn();
            const wrapped = createWrapper({
                contribution: contributionWith((method) => {
                    called(method);
                    return successFor(method);
                }),
            });
            await expect(wrapped.resolveSource({
                ...requestFor('resolveSource'),
                source: { kind } as AgentExternalSessionSource,
            })).resolves.toEqual({ ok: false, code: 'invalid_request', retryable: false });
            expect(called, kind).not.toHaveBeenCalled();
        }

        // A contribution-returned source travels the same canonical parser.
        const returnedUntrimmedKind = createWrapper({
            contribution: contributionWith(() => ({
                ok: true as const,
                value: { source: { kind: ' fixture' } },
            })),
        });
        await expect(returnedUntrimmedKind.resolveSource(requestFor('resolveSource')))
            .resolves.toEqual({ ok: false, code: 'agent_error', retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u), });
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
        })).resolves.toEqual({ ok: false, code: 'agent_error', retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u), });

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
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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

    it('accepts structural and accessor-backed output DTOs while rejecting unknown and invalid data', async () => {
        const accessor = {};
        Object.defineProperty(accessor, 'source', {
            enumerable: true,
            get: () => source,
        });
        class StructuralResult {
            get source() {
                return source;
            }
        }
        const accepted: readonly unknown[] = [
            accessor,
            Object.assign(Object.create({ inherited: true }), { source }),
            new StructuralResult(),
        ];
        for (const value of accepted) {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({ ok: true, value })),
            });
            await expect(wrapped.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
                ok: true,
                value: { source },
            });
        }
        const rejected: readonly unknown[] = [
            { source, extra: true },
            { source: { kind: 'fixture', value: Number.POSITIVE_INFINITY } },
        ];
        for (const value of rejected) {
            const wrapped = createWrapper({
                contribution: contributionWith(() => ({ ok: true, value })),
            });
            await expect(wrapped.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
                ok: false,
                code: 'agent_error',
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
            });
        }

        const throwing = Object.defineProperty({}, 'source', {
            enumerable: true,
            get: () => { throw new Error('property read failed'); },
        });
        const wrapped = createWrapper({
            contribution: contributionWith(() => ({ ok: true, value: throwing })),
        });
        await expect(wrapped.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
        });
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
                retryable: false, message: expect.stringMatching(/^external_sessions_[a-z_]+$/u),
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
            message: 'external_sessions_operation_rejected',
        });
        await expect(asyncFailure.resolveSource(requestFor('resolveSource'))).resolves.toEqual({
            ok: false,
            code: 'agent_error',
            retryable: false,
            message: 'external_sessions_operation_rejected',
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
        const cursorPayload = JSON.parse(Buffer.from(
            first.value.nextCursor.slice('happier_external_cursor_v1:'.length),
            'base64url',
        ).toString('utf8'));
        expect(cursorPayload).toMatchObject({
            s: 'k8lKpzUekt_M2U67yXPwVdBPEbwAlcJT-l9lwkjd9HQ',
        });

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
            identity: { ...identity, occurrenceId: 'occurrence-8' },
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
            cursor: 'x'.repeat(EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes + 1),
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
                            hasMore: false,
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


describe('bounded selected-page candidate hydration', () => {
    const candidates: readonly AgentExternalSessionCandidate[] = Object.freeze([
        Object.freeze({ remoteSessionId: 'remote-1', updatedAtMs: 7, createdAtMs: 2,
            archived: false, thread: { kind: 'subagent' as const, parentRemoteSessionId: 'parent' },
            linkData: { path: '/native/session' }, candidateIndexState: { cursor: 'checkpoint' },
            match: { snippet: 'hit', sourceItemId: 'item', messageIndex: 1 } }),
        Object.freeze({ remoteSessionId: 'remote-2', updatedAtMs: 8 }),
    ]);
    const request = () => ({ source, candidates, signal: new AbortController().signal,
        maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes });
    const withHydration = (hydrateCandidates: NonNullable<AgentExternalSessionsContribution['hydrateCandidates']>) =>
        Object.freeze({ ...contributionWith(method => successFor(method)), hydrateCandidates });

    it('keeps old contributions unsupported without invoking their listing operation', async () => {
        const calls: MethodName[] = [];
        const wrapped = createWrapper({ contribution: contributionWith(method => {
            calls.push(method);
            return successFor(method);
        }) });
        expect(wrapped.supportsCandidateHydration).toBe(false);
        await expect(wrapped.hydrateCandidates(request())).resolves.toMatchObject({ ok: false, code: 'unsupported' });
        expect(calls).toEqual([]);
    });

    it('admits display enrichment while preserving all original identity and index facts', async () => {
        const wrapped = createWrapper({ contribution: withHydration(input => ({ ok: true, value: {
            candidates: input.candidates.map(candidate => ({ ...candidate, title: 'Hydrated', cwd: '/project', messageCount: 4 })),
        } })) });
        expect(wrapped.supportsCandidateHydration).toBe(true);
        await expect(wrapped.hydrateCandidates(request())).resolves.toEqual({ ok: true, value: {
            candidates: candidates.map(candidate => ({ ...candidate, title: 'Hydrated', cwd: '/project', messageCount: 4 })),
        } });
    });

    it.each([
        ['count', (rows: readonly AgentExternalSessionCandidate[]) => rows.slice(1)],
        ['order', (rows: readonly AgentExternalSessionCandidate[]) => [...rows].reverse()],
        ['identity', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, remoteSessionId: 'other' }))],
        ['updated timestamp', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, updatedAtMs: 99 }))],
        ['creation timestamp', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, createdAtMs: 99 }))],
        ['archive state', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, archived: true }))],
        ['thread', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, thread: undefined }))],
        ['link data', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, linkData: {} }))],
        ['checkpoint', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, candidateIndexState: {} }))],
        ['match', (rows: readonly AgentExternalSessionCandidate[]) => rows.map(row => ({ ...row, match: undefined }))],
    ])('rejects producer changes to %s', async (_label, change) => {
        const wrapped = createWrapper({ contribution: withHydration(input => ({ ok: true,
            value: { candidates: change(input.candidates) } })) });
        await expect(wrapped.hydrateCandidates(request())).resolves.toMatchObject({ ok: false, code: 'agent_error', retryable: false });
    });

    it('rejects malformed and oversized candidate requests before invoking the producer', async () => {
        let calls = 0;
        const wrapped = createWrapper({ contribution: withHydration(input => {
            calls += 1;
            return { ok: true, value: { candidates: input.candidates } };
        }) });
        await expect(wrapped.hydrateCandidates({ ...request(), candidates: [{ ...candidates[0]!, updatedAtMs: -1 }] }))
            .resolves.toMatchObject({ ok: false, code: 'invalid_request' });
        await expect(wrapped.hydrateCandidates({ ...request(), candidates: Array.from({ length:
            EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems + 1 }, () => candidates[0]!) }))
            .resolves.toMatchObject({ ok: false, code: 'invalid_request' });
        await expect(wrapped.hydrateCandidates({ ...request(), maxSerializedBytes: 0 }))
            .resolves.toMatchObject({ ok: false, code: 'invalid_request' });
        await expect(wrapped.hydrateCandidates({ ...request(), candidates: [{ ...candidates[0]!,
            cwd: '/'.repeat(EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes) }] }))
            .resolves.toMatchObject({ ok: false, code: 'invalid_request' });
        expect(calls).toBe(0);
    });

    it('inherits the caller deadline, byte budget and host execution services', async () => {
        const deadlineAtMs = Date.now() + 10_000;
        const wrapped = createWrapper({ contribution: withHydration(input => {
            expect(input.deadlineAtMs).toBe(deadlineAtMs);
            expect(input.maxSerializedBytes).toBe(2_048);
            expect(input.exec).toBe(unavailableInvocationExec);
            expect(typeof input.ripgrep.run).toBe('function');
            expect(typeof input.managedEndpointRead).toBe('function');
            return { ok: true, value: { candidates: input.candidates.map(row => ({ ...row, title: 'x'.repeat(3_000) })) } };
        }) });
        await expect(wrapped.hydrateCandidates({ ...request(), deadlineAtMs, maxSerializedBytes: 2_048 }))
            .resolves.toMatchObject({ ok: false, code: 'agent_error' });
    });

    it.each(['cancelled', 'unavailable'] as const)('settles pending hydration when %s', async code => {
        const entered = deferred<void>();
        const controller = new AbortController();
        const retirement = new AbortController();
        const wrapped = createWrapper({ retirementSignal: retirement.signal, contribution: withHydration(() => {
            entered.resolve();
            return new Promise(() => undefined);
        }) });
        const result = wrapped.hydrateCandidates({ ...request(), signal: controller.signal });
        await entered.promise;
        if (code === 'cancelled') controller.abort();
        else retirement.abort();
        await expect(result).resolves.toMatchObject({ ok: false, code });
    });

    it('settles pending hydration at the inherited deadline', async () => {
        vi.useFakeTimers();
        try {
            const entered = deferred<void>();
            const wrapped = createWrapper({ contribution: withHydration(() => {
                entered.resolve();
                return new Promise(() => undefined);
            }) });
            const result = wrapped.hydrateCandidates({ ...request(), deadlineAtMs: Date.now() + 25 });
            await entered.promise;
            await vi.advanceTimersByTimeAsync(25);
            await expect(result).resolves.toMatchObject({ ok: false, code: 'timeout' });
        } finally {
            vi.useRealTimers();
        }
    });
});

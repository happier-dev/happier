// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { SessionPullRequestStatusResourceResultV1Schema, type SessionPullRequestStatusResourceResultV1 } from '@happier-dev/triage-protocol/v1';

import { createSessionPullRequestOperationsBinding } from '../testkit/sessionPullRequestOperations.test-support.js';
import { useTriageSessionPullRequestStatusV1, type TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';
import { usePullRequestOperationsV1 } from './usePullRequestOperations.js';
import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from '../sessionPullRequestResourceId.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mounted original PR operation lifetime', () => {
    it.each(['permission', 'binding', 'caller'] as const)('preserves admitted mutation and caller lifetime boundaries (%s)', async change => {
        const first = createSessionPullRequestOperationsBinding();
        const second = { ...first, bindingId: 'binding-2', link: { ...first.link, number: 8, url: 'https://github.com/acme/widgets/pull/8' } };
        let value: SessionPullRequestStatusResourceResultV1 = { kind: 'ready', sessionId: 'session-1', pullRequests: [first, second] };
        const caller = new AbortController();
        let selected!: ReturnType<typeof usePullRequestOperationsV1>;
        let selectBinding!: React.Dispatch<React.SetStateAction<string>>;
        let complete!: () => void;
        let started!: () => void;
        let mutationSignal: AbortSignal | undefined;
        let effects = 0;
        let digest = `sha256:${'a'.repeat(64)}`;
        const entered = new Promise<void>(resolve => { started = resolve; });
        const outcome = { outcome: { kind: 'applied', effect: 'changed', confirmedState: null, confirmedEntryRef: null,
            presentation: { title: 'Original mutation completed', description: 'The captured request settled.', tone: 'secondary' } } } as const;
        function Probe() {
            const [bindingId, setBindingId] = React.useState('binding-1');
            selectBinding = setBindingId;
            selected = usePullRequestOperationsV1('session-1', bindingId, caller.signal);
            return <><Text value={selected.operations ? bindingId : 'unavailable'} />{selected.primaryWrite?.feedback}</>;
        }
        let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
        await act(async () => { fixture = await createPluginUiTestkit({
            identity: { instanceId: 'pr-operation-lifetime', mountNonce: 'pr-operation-lifetime-mount' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: defineUiSurface(() => <Probe />), surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                readResource: () => ({ contentType: 'application/json', digest,
                    bytes: new TextEncoder().encode(JSON.stringify(SessionPullRequestStatusResourceResultV1Schema.parse(value))) }),
                watchResource: () => ({ digest }),
                executeAction: ({ input, signal }) => {
                    effects++;
                    expect(input).toEqual({ headRevision: 'a'.repeat(40), mergeMethod: 'squash' });
                    mutationSignal = signal;
                    started();
                    return new Promise(resolve => { complete = () => resolve(outcome); });
                },
            },
        }); });
        let pending!: Promise<unknown>;
        try {
            await fixture.getByText('binding-1');
            await act(async () => { pending = selected.primaryWrite!.execute('squash'); void pending.catch(() => {}); });
            await entered;
            if (change === 'permission') {
                value = { kind: 'unavailable', sessionId: 'session-1', failure: { class: 'permission', code: 'sourceUnavailable' } };
                digest = `sha256:${'b'.repeat(64)}`;
                await act(async () => { fixture.invalidateResource(TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1, digest); });
                await fixture.getByText('unavailable');
            } else if (change === 'binding') {
                await act(async () => { selectBinding('binding-2'); });
                await fixture.getByText('binding-2');
            } else await act(async () => { caller.abort(); });
            const abortedBeforeCompletion = mutationSignal?.aborted;
            await act(async () => { complete(); await pending.catch(() => {}); });
            expect(abortedBeforeCompletion).toBe(change !== 'permission');
            expect(effects).toBe(1);
            expect(await fixture.queryByText('Original mutation completed')).toBeUndefined();
        } finally {
            complete?.();
            await pending?.catch(() => {});
            await act(async () => { await fixture.dispose(); });
        }
    });

    it('keeps the current offer gate without cancelling an admitted host request on source retirement', async () => {
        let control!: ReturnType<typeof usePullRequestOperationsV1>;
        let binding: TriageSessionPullRequestBindingV1 | null = createSessionPullRequestOperationsBinding();
        let refresh!: () => Promise<void>;
        let reads = 0;
        let watches = 0;
        let revision = 1;
        const digest = () => `sha256:${String(revision).padStart(64, '0')}`;
        const calls: unknown[] = [];
        const signals: AbortSignal[] = [];
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'native-operations', mountNonce: 'native-operations-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: 'session-1' } }),
                adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                surface: defineUiSurface(context => {
                    refresh = useTriageSessionPullRequestStatusV1(snapshot => snapshot).refresh;
                    control = usePullRequestOperationsV1('session-1', 'binding-1', context.signal);
                    return null;
                }),
                handlers: {
                    readResource: async () => { reads += 1; return { contentType: 'application/json', digest: digest(),
                        bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: 'session-1',
                            pullRequests: binding ? [binding] : [] })) }; },
                    watchResource: () => { watches += 1; return { digest: digest() }; },
                    executeAction: async ({ action, input, signal }) => {
                    calls.push({ action, input }); signals.push(signal);
                    await held;
                    if (signal.aborted) throw new DOMException('Operation retired', 'AbortError');
                    return { kind: 'uncertain' };
                } },
            });
        });
        try {
            expect(reads).toBe(1);
            expect(watches).toBe(1);
            binding = null;
            revision += 1;
            await act(async () => { await refresh(); });
            expect(control.operations).toBeUndefined();
            expect(await control.execute('merge', 'squash')).toEqual({ kind: 'unavailable', reason: 'operationUnavailable' });
            expect(calls).toEqual([]);
            binding = createSessionPullRequestOperationsBinding();
            revision += 1;
            await act(async () => { await refresh(); });
            expect(control.operations).toBeDefined();
            const pending = control.execute('cancelAutoMerge');
            void pending.catch(() => {});
            await act(async () => { await Promise.resolve(); });
            expect(calls).toHaveLength(1);
            if (!binding || binding.nativeStatus.kind !== 'current' || !binding.nativeStatus.value.operations) throw new Error('Expected current source offers');
            binding = { ...binding, nativeStatus: { ...binding.nativeStatus, value: { ...binding.nativeStatus.value,
                operations: { ...binding.nativeStatus.value.operations, readiness: 'blocked',
                    primary: { ...binding.nativeStatus.value.operations.primary, disabledReason: 'Another requirement changed' } },
            } } };
            revision += 1;
            await act(async () => { await refresh(); });
            expect(signals[0]?.aborted).toBe(false);
            binding = null;
            revision += 1;
            await act(async () => { await refresh(); });
            expect(signals[0]?.aborted).toBe(false);
            release();
            await expect(pending).resolves.toEqual({ kind: 'uncertain' });
            expect(calls).toHaveLength(1);
            expect(reads).toBe(5);
            expect(watches).toBe(1);
        } finally { release(); await fixture.dispose(); }
    });
});

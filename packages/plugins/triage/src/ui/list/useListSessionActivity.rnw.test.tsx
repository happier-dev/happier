// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PluginError } from '@happier-dev/plugin-sdk';

import { testkitEntryRef, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import { useTriageListSessionActivityV1 } from './useListSessionActivity.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
function completeCoverage(entryRef: ReturnType<typeof testkitEntryRef>) {
    return [{ source: entryRef.source, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel: 'Example forge',
        kindIds: [entryRef.kindId], health: { kind: 'complete' as const } }];
}
afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the list relationship join', () => {
    it('keeps terminal Session reads quiet, isolates incomplete relations, and retries failed reads only on request', async () => {
        const linked = testkitEntryRef();
        const unlinked = { ...linked, entryId: 'unlinked' };
        let failLinked = false;
        let sessionRead: 'ready' | 'missing' | 'failed' | 'denied' = 'ready';
        let sessionReads = 0;
        let sessionWatches = 0;
        let current: ReturnType<typeof useTriageListSessionActivityV1> | undefined;
        const surface = defineUiSurface(() => {
            current = useTriageListSessionActivityV1({ entryRefs: [linked, unlinked], acquisition: 1, active: true });
            return <Button title="Retry activity" onPress={current.retry} />;
        });
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({ identity: { instanceId: 'independent-relations', mountNonce: 'independent-relations-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
                surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                handlers: {
                    watchSession: () => {
                        sessionWatches += 1;
                        throw new PluginError({ code: 'unavailable' });
                    },
                    readSession: () => {
                        sessionReads += 1;
                        if (sessionRead === 'failed' || sessionRead === 'denied') throw new PluginError({ code: 'unavailable', retryable: sessionRead === 'failed' });
                        return sessionRead === 'ready' ? ({ sessionId: 'answered-session', lifecycle: 'active', runtime: 'idle',
                            operational: 'ready', pendingPermissions: [],
                            workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' } }) : null;
                    },
                    executeAction: async () => ({ kind: 'entries', entries: [linked, unlinked].map(entryRef => ({ entryRef,
                        result: entryRef === unlinked || failLinked ? { kind: 'failed', links: [], lanes: [{
                            ...completeCoverage(entryRef)[0]!, health: { kind: 'unavailable' },
                        }] } : { kind: 'complete', links: [{ entryRef, sessionId: 'answered-session', linkedAtMs: 1,
                            displayPath: 'Answered entry' }], lanes: completeCoverage(entryRef) },
                    })) }),
                },
            });
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        expect(current?.agentStates.get(triageEntryRowKey(linked))).toHaveLength(1);
        // Membership coverage stays explicitly incomplete; it cannot rewrite
        // another entry's successfully read relationship and Session activity.
        expect(current).toMatchObject({ linksStatus: 'unavailable', unavailable: false, incomplete: false });
        expect({ reads: sessionReads, watches: sessionWatches }).toEqual({ reads: 1, watches: 1 });
        failLinked = true;
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry activity' })); });
        expect(current).toMatchObject({ linksStatus: 'unavailable', unavailable: true, incomplete: true });
        expect(current?.linkedSessions.get(triageEntryRowKey(linked))).toEqual(['answered-session']);
        failLinked = false;
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry activity' })); });
        expect(current).toMatchObject({ linksStatus: 'unavailable', unavailable: false, incomplete: false });
        sessionRead = 'missing';
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry activity' })); });
        expect(current).toMatchObject({ unavailable: false, incomplete: false, unreachable: true });
        expect(current?.linkedSessions.get(triageEntryRowKey(linked))).toEqual(['answered-session']);
        expect(current?.agentStates.has(triageEntryRowKey(linked))).toBe(false);
        await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
        expect(current).toMatchObject({ unavailable: false, incomplete: false, unreachable: true });
        expect({ reads: sessionReads, watches: sessionWatches }).toEqual({ reads: 4, watches: 4 });
        sessionRead = 'denied';
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry activity' })); });
        expect(current).toMatchObject({ unavailable: false, incomplete: false, unreachable: true });
        sessionRead = 'failed';
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry activity' })); });
        expect(current).toMatchObject({ unavailable: true, incomplete: true });
        expect({ reads: sessionReads, watches: sessionWatches }).toEqual({ reads: 6, watches: 6 });
        sessionRead = 'ready';
        await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
        expect(current).toMatchObject({ unavailable: true, incomplete: true });
        expect({ reads: sessionReads, watches: sessionWatches }).toEqual({ reads: 6, watches: 6 });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry activity' })); });
        expect(current).toMatchObject({ unavailable: false, incomplete: false });
        expect({ reads: sessionReads, watches: sessionWatches }).toEqual({ reads: 7, watches: 7 });
    });

    it('reads the demanded window once through the composed Action without acquiring entry detail', async () => {
        const entries = Array.from({ length: 100 }, (_, index) => ({ ...testkitEntryRef(), entryId: String(index) }));
        const calls: Array<{ action: string; input: unknown }> = [];
        const diagnostics: unknown[] = [];
        let current: ReturnType<typeof useTriageListSessionActivityV1> | undefined;
        const surface = defineUiSurface(() => {
            const activity = useTriageListSessionActivityV1({ entryRefs: entries, acquisition: 1, active: true });
            current = activity;
            return <Text value={`status:${activity.linksStatus}`} />;
        });
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'relation-list', mountNonce: 'relation-list-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
                surfaceContext: createSurfaceContextFixture(),
                adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                handlers: { diagnostic: ({ data }) => { diagnostics.push(data); }, executeAction: async ({ action, input }) => {
                    calls.push({ action: String(action), input });
                    if (String(action) !== 'sessions/read-source-links-v1') throw new Error('Only relationships are demanded');
                    const selected = (input as { entries: Array<{ entryRef: ReturnType<typeof testkitEntryRef> }> }).entries;
                    return { kind: 'entries', entries: selected.map(({ entryRef }) => ({ entryRef,
                        result: { kind: 'complete', links: [{ entryRef, sessionId: `session-${entryRef.entryId}`,
                            linkedAtMs: 1, displayPath: `entry/${entryRef.entryId}` }], lanes: completeCoverage(entryRef) } })) };
                } },
            });
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        expect(diagnostics).toEqual([]);
        expect(current?.linksStatus).toBe('ready');
        await expect(fixture.getByText('status:ready')).resolves.toBeDefined();
        expect(entries.map(entry => current?.linkedSessions.get(triageEntryRowKey(entry))))
            .toEqual(entries.map(entry => [`session-${entry.entryId}`]));
        expect(calls).toEqual([{ action: 'sessions/read-source-links-v1', input: { v: 1, entries: entries.map(entryRef => ({ entryRef })) } }]);
        await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
        expect(calls).toHaveLength(1);
    });

    it('keeps answered links quiet when a pending reread retires with its surface', async () => {
        const entryRef = testkitEntryRef();
        let current: ReturnType<typeof useTriageListSessionActivityV1> | undefined;
        let refuseRead: ((error: Error) => void) | undefined;
        let pendingSignal: AbortSignal | undefined;
        let reads = 0;
        const diagnostics: unknown[] = [];
        const surface = defineUiSurface(() => {
            const [active, setActive] = React.useState(true);
            current = useTriageListSessionActivityV1({ entryRefs: [entryRef], acquisition: 1, active });
            return <><Text value={`status:${current.linksStatus}`} />
                <Button title="Refresh links" onPress={current.retry} />
                <Button title="Retire list" onPress={() => setActive(false)} /></>;
        });
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({ identity: { instanceId: 'retired-list', mountNonce: 'retired-list-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
                surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                handlers: {
                    diagnostic: ({ data }) => { diagnostics.push(data); },
                    readSession: () => ({ sessionId: 'linked-session', lifecycle: 'active', runtime: 'idle',
                        operational: 'ready', pendingPermissions: [],
                        workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' } }),
                    executeAction: async ({ signal }) => {
                        reads += 1;
                        if (reads > 1) {
                            pendingSignal = signal;
                            return new Promise<never>((_resolve, reject) => { refuseRead = reject; });
                        }
                        return { kind: 'entries', entries: [{ entryRef, result: { kind: 'complete',
                            links: [{ entryRef, sessionId: 'linked-session', linkedAtMs: 1, displayPath: 'Linked PR' }],
                            lanes: completeCoverage(entryRef) } }] };
                    },
                },
            });
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        expect(current?.unavailable).toBe(false);
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh links' })); });
        expect(refuseRead).toBeDefined();
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retire list' })); });
        expect(pendingSignal?.aborted).toBe(true);
        await act(async () => { refuseRead?.(new PluginError({ code: 'stale_surface', diagnostics: ['plugin_surface_retired'] })); });
        expect(current?.linkedSessions.get(triageEntryRowKey(entryRef))).toEqual(['linked-session']);
        expect(current?.linksStatus).toBe('ready');
        expect(current?.unavailable).toBe(false);
        expect(diagnostics).toEqual([]);
        expect(reads).toBe(2);
    });

    it('preserves unreadable relations while replacing healthy complete-empty answers on retry', async () => {
        const pr = testkitEntryRef();
        const issue = { ...pr, kindId: 'issue' };
        const entries = [pr, issue];
        let retry = false;
        const surface = defineUiSurface(() => {
            const activity = useTriageListSessionActivityV1({ entryRefs: entries, acquisition: 1, active: true });
            return <><Text value={JSON.stringify({ status: activity.linksStatus,
                links: entries.map(entry => activity.linkedSessions.get(triageEntryRowKey(entry)) ?? []) })} />
                <Button title="Retry relationships" onPress={activity.retry} /></>;
        });
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({ identity: { instanceId: 'partial-list', mountNonce: 'partial-list-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
                surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                handlers: { executeAction: async ({ action, input }) => {
                    if (String(action) !== 'sessions/read-source-links-v1') throw new Error('Only relationships are demanded');
                    const selected = (input as { entries: Array<{ entryRef: ReturnType<typeof testkitEntryRef> }> }).entries;
                    return { kind: 'entries', entries: selected.map(({ entryRef }) => ({ entryRef,
                        result: retry ? { kind: entryRef.kindId === pr.kindId ? 'failed' : 'complete', links: [], lanes: [{
                            ...completeCoverage(entryRef)[0]!, health: entryRef.kindId === pr.kindId ? { kind: 'unavailable' } : { kind: 'complete' },
                        }] }
                            : { kind: 'complete', links: [{ entryRef, sessionId: `session-${entryRef.kindId}`,
                                linkedAtMs: 1, displayPath: entryRef.kindId }], lanes: completeCoverage(entryRef) },
                    })) };
                } },
            });
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText(JSON.stringify({ status: 'ready', links: [['session-pull-request'], ['session-issue']] })))
            .resolves.toBeDefined();
        retry = true;
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry relationships' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText(JSON.stringify({ status: 'unavailable', links: [['session-pull-request'], []] })))
            .resolves.toBeDefined();
    });

    it('does not rerender an unchanged entry when another demanded relation changes', async () => {
        const entries = [testkitEntryRef(), testkitEntryRef({ entryId: '18' })];
        let version = 1;
        let firstEntryRenders = 0;
        const LinkedRow = React.memo(function LinkedRow(props: Readonly<{ sessionIds: readonly string[] }>) {
            firstEntryRenders += 1;
            return <Text value={props.sessionIds.join(',')} />;
        });
        const noSessions: readonly string[] = [];
        const surface = defineUiSurface(() => {
            const activity = useTriageListSessionActivityV1({ entryRefs: entries, acquisition: 1, active: true });
            return <><LinkedRow sessionIds={activity.linkedSessions.get(triageEntryRowKey(entries[0]!)) ?? noSessions} />
                <Text value={`status:${activity.linksStatus}`} /><Button title="Refresh links" onPress={activity.retry} /></>;
        });
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({ identity: { instanceId: 'identity-list', mountNonce: 'identity-list-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
                surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                handlers: { executeAction: async () => ({ kind: 'entries', entries: entries.map((entryRef, index) => ({ entryRef,
                    result: { kind: 'complete', links: [{ entryRef, sessionId: index === 0 ? 'stable-session' : `other-${version}`,
                        linkedAtMs: 1, displayPath: entryRef.entryId }], lanes: completeCoverage(entryRef) },
                })) }) },
            });
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('stable-session')).resolves.toBeDefined();
        const baseline = firstEntryRenders;
        version = 2;
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh links' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('status:ready')).resolves.toBeDefined();
        expect(firstEntryRenders).toBe(baseline);
    });
});

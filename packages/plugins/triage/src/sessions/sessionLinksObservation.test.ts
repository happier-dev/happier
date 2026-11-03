import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { TriageDataActionContext } from '../actions/dataContext.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { testkitConfiguredInstance, testkitReadOnlySourceSnapshot } from './testkit/entrySessionTestkit.test-support.js';
import { observeTriageSourceSessionLinks } from './sessionLinksObservation.js';
import { linkEntryToSession } from './entrySessionLinks.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';

describe('the composed relation dependency observer', () => {
    it('keeps a held targeted read alive across dependency invalidation and replaces the selected roles', async () => {
        const { watchableCollections, control } = createTestkitCorpusCollections();
        const instance = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance }));
        const source = testkitReadOnlySourceSnapshot().contributions[0]!;
        const firstRole = { role: 'first-read' };
        const nextRole = { role: 'next-read' };
        let role = firstRole;
        let changed: (() => void) | undefined;
        let heldSignal: AbortSignal | undefined;
        let release: (() => void) | undefined;
        let reads = 0;
        const disposedRoles: unknown[] = [];
        const attachedRoles: unknown[] = [];
        const context = { signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? watchableCollections.sessionLinks : watchableCollections.sourceInstances } },
                // Only the admitted registry and Action observation transports are supplied.
                targetedContributions: { observeForSelf: (_point: unknown, options: { onInvalidated: () => void }) => {
                    changed ??= options.onInvalidated;
                    return { readCurrent: async ({ signal }: { signal: AbortSignal }) => {
                        if (reads++ === 0) {
                            heldSignal = signal;
                            await new Promise<void>((resolve, reject) => {
                                release = resolve;
                                signal.addEventListener('abort', () => reject(new PluginError({
                                    code: 'plugin_targeted_contributions_aborted', message: 'Read retired',
                                })), { once: true });
                            });
                        }
                        return { contributions: [{ ...source,
                            descriptor: { ...source.descriptor, sessionRelations: { kindIds: ['pull-request'] } },
                            operations: { readSessionLinks: role, linkSession: { role: 'write' } },
                        }] };
                    }, dispose() {} };
                } },
                actions: { observeAdmittedTargetedOperation: async (operation: unknown) => {
                    attachedRoles.push(operation);
                    return { dispose: () => { disposedRoles.push(operation); } };
                } },
            },
        } as unknown as TriageDataActionContext;
        const pending = observeTriageSourceSessionLinks({ v: 1, sessionId: 'selected-session' }, vi.fn(), context)
            .then(observer => ({ observer }), error => ({ error }));
        try {
            await vi.waitFor(() => expect(heldSignal).toBeDefined());
            changed?.(); // Same selected inputs, while the first registry response is still pending.
            expect(heldSignal?.aborted).toBe(false);
            release?.();
            const result = await pending;
            if ('error' in result) throw result.error;
            await vi.waitFor(() => expect(attachedRoles).toEqual([firstRole]));
            role = nextRole;
            changed?.();
            await vi.waitFor(() => expect(attachedRoles).toEqual([firstRole, nextRole]));
            expect(disposedRoles).toEqual([firstRole]);
            expect(heldSignal?.aborted).toBe(false);
            await result.observer.dispose();
            expect(heldSignal?.aborted).toBe(true);
            expect(disposedRoles).toEqual([firstRole, nextRole]);
        } finally {
            release?.();
            const result = await pending;
            if ('observer' in result) await result.observer.dispose();
        }
    });

    it('observes selected corpus mutations even when the admitted source inventory is empty', async () => {
        const { collections, watchableCollections } = createTestkitCorpusCollections();
        const context = { surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.triage' }, signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? watchableCollections.sessionLinks : watchableCollections.sourceInstances } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [] }), dispose() {} }) },
                actions: {},
            },
        } as unknown as TriageDataActionContext;
        const invalidate = vi.fn();
        const observer = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'selected-session' }, invalidate, context);
        await linkEntryToSession({ collections, entryRef: testkitEntryRef({ kindId: 'issue' }), sessionId: 'unrelated-session',
            display: { locator: { v: 1, displayPath: 'Issue' }, scopeLabel: 'example/repository' }, nowMs: 1 });
        expect(invalidate).not.toHaveBeenCalled();
        await linkEntryToSession({ collections, entryRef: testkitEntryRef({ kindId: 'issue' }), sessionId: 'selected-session',
            display: { locator: { v: 1, displayPath: 'Issue' }, scopeLabel: 'example/repository' }, nowMs: 1 });
        expect(invalidate).toHaveBeenCalledOnce();
        await observer.dispose();
    });

    it('awaits all selected role cleanup through rebuild and retains one rejecting final disposal', async () => {
        const { watchableCollections, control } = createTestkitCorpusCollections();
        const instance = testkitConfiguredInstance();
        const configured = { instanceTag: 'a'.repeat(43), lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance };
        control.sourceInstances.seed(toCorpusStoredValue(configured));
        const source = testkitReadOnlySourceSnapshot().contributions[0]!;
        let settleOld: (() => void) | undefined;
        const oldCleanup = new Promise<void>(resolve => { settleOld = resolve; });
        let rejectCurrent: ((reason: unknown) => void) | undefined;
        const currentCleanup = new Promise<void>((_resolve, reject) => { rejectCurrent = reject; });
        const oldDispose = vi.fn(() => oldCleanup);
        const currentDispose = vi.fn(() => currentCleanup);
        let attachments = 0;
        const dependencyChanges: Array<() => void> = [];
        const observeRole = vi.fn(async (_operation: unknown, _input: unknown, changed: () => void) => {
            dependencyChanges.push(changed);
            return { dispose: attachments++ === 0 ? oldDispose : currentDispose };
        });
        const context = { surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.triage' }, signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? watchableCollections.sessionLinks : watchableCollections.sourceInstances } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{ ...source,
                    descriptor: { ...source.descriptor, sessionRelations: { kindIds: ['pull-request'] } },
                    operations: { readSessionLinks: { role: 'read' }, linkSession: { role: 'write' } },
                }] }), dispose() {} }) },
                actions: { observeAdmittedTargetedOperation: observeRole },
            },
        } as unknown as TriageDataActionContext;
        const invalidate = vi.fn();
        const observer = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'selected-session' }, invalidate, context);
        control.sourceInstances.seed(toCorpusStoredValue({ ...configured, configuredAtMs: 2 }));
        await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledOnce());
        expect(observeRole).toHaveBeenCalledOnce();
        const afterRebuildStarted = invalidate.mock.calls.length;
        dependencyChanges[0]?.();
        expect(invalidate).toHaveBeenCalledTimes(afterRebuildStarted);
        settleOld?.();
        await vi.waitFor(() => expect(observeRole).toHaveBeenCalledTimes(2));
        const cleanup = observer.dispose();
        expect(cleanup).toBeInstanceOf(Promise);
        expect(observer.dispose()).toBe(cleanup);
        let settled = false;
        const failure = new Error('source observer cleanup failed');
        const result = Promise.resolve(cleanup).finally(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        const rejected = expect(result).rejects.toBe(failure);
        rejectCurrent?.(failure);
        await rejected;
        expect(oldDispose).toHaveBeenCalledOnce();
        expect(currentDispose).toHaveBeenCalledOnce();
    });

    it('keeps healthy corpus observation when a role observer is refused and requires the paired role scope', async () => {
        const { collections, watchableCollections, control } = createTestkitCorpusCollections();
        const instance = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43), lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance }));
        const source = testkitReadOnlySourceSnapshot().contributions[0]!;
        let paired = true;
        const observeRole = vi.fn(async () => { throw new PluginError({ code: 'plugin_action_read_only_required', message: 'Read observation refused' }); });
        // Real ownership and selected persistence observation; only host registry/Action transports are supplied.
        const context = { surface: 'ui', caller: { kind: 'plugin', pluginId: 'happier.triage' }, signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? watchableCollections.sessionLinks : watchableCollections.sourceInstances } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{ ...source,
                    descriptor: { ...source.descriptor, sessionRelations: { kindIds: ['pull-request'] } },
                    operations: { readSessionLinks: { role: 'read' }, ...(paired ? { linkSession: { role: 'write' } } : {}) },
                }] }), dispose() {} }) },
                actions: { observeAdmittedTargetedOperation: observeRole },
            },
        } as unknown as TriageDataActionContext;
        const invalidate = vi.fn();
        const observer = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'selected-session' }, invalidate, context);
        expect(observeRole).toHaveBeenCalledOnce();
        expect(invalidate).toHaveBeenCalledOnce(); // A refused observer is not a successful subscription.
        invalidate.mockClear();
        await linkEntryToSession({ collections, entryRef: testkitEntryRef({ kindId: 'issue' }), sessionId: 'selected-session',
            display: { locator: { v: 1, displayPath: 'Issue' }, scopeLabel: 'example/repository' }, nowMs: 1 });
        expect(invalidate).toHaveBeenCalledOnce();
        await observer.dispose();
        paired = false;
        const unpaired = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'selected-session' }, invalidate, context);
        expect(observeRole).toHaveBeenCalledOnce();
        await unpaired.dispose();
    });

    it('watches the exact corpus Session and admitted role without invoking a read handler', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const instance = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43), lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance }));
        const snapshot = testkitReadOnlySourceSnapshot();
        const source = snapshot.contributions[0]!;
        const role = { role: 'readSessionLinks' };
        const corpusQueries: unknown[] = [];
        const corpusListeners: Array<() => void> = [];
        const disposeCorpus = vi.fn();
        const execute = vi.fn(async () => { throw new Error('Observation must not invoke a source read'); });
        let roleChanged: (() => void) | undefined;
        const disposeRole = vi.fn();
        const observeRole = vi.fn(async (_role: unknown, _input: unknown, changed: () => void) => {
            roleChanged = changed;
            return { dispose: disposeRole };
        });
        // Only storage/registry/Action observer transports are replaced; selection runs through the real owner.
        const context = { surface: 'ui', caller: { kind: 'plugin', pluginId: 'happier.triage' }, signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? { ...collections.sessionLinks, watch: (query: unknown, listener: () => void) => {
                    corpusQueries.push(query); corpusListeners.push(listener); return { dispose: disposeCorpus };
                } } : { ...collections.sourceInstances, watch: () => ({ dispose() {} }) } } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{ ...source,
                    descriptor: { ...source.descriptor, kinds: source.descriptor.kinds.filter(kind => kind.id === 'pull-request'),
                        sessionRelations: { kindIds: ['pull-request'] } },
                    operations: { readSessionLinks: role, linkSession: { role: 'linkSession' } },
                }] }), dispose() {} }) },
                actions: { executeAdmittedTargetedOperation: execute, observeAdmittedTargetedOperation: observeRole },
            },
        } as unknown as TriageDataActionContext;
        const invalidate = vi.fn();
        const observer = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'session-a' }, invalidate, context);
        expect(corpusQueries).toEqual([{ index: 'by-session', prefix: ['session-a'], order: 'asc' }]);
        expect(observeRole).toHaveBeenCalledExactlyOnceWith(role,
            { v: 1, instance, sessionId: 'session-a' }, expect.any(Function), { signal: expect.any(AbortSignal) });
        expect(execute).not.toHaveBeenCalled();
        invalidate.mockClear();
        corpusListeners[0]?.();
        roleChanged?.();
        expect(invalidate).toHaveBeenCalledTimes(2);
        // Removing a configured connection does not remove definitively
        // corpus-owned retained Issue links or their Session dependency.
        control.sourceInstances.tombstone('a'.repeat(43));
        const retained = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'session-a' }, invalidate, context);
        expect(corpusQueries).toHaveLength(2);
        expect(observeRole).toHaveBeenCalledTimes(1);
        await retained.dispose();
        await observer.dispose();
        expect(disposeCorpus).toHaveBeenCalledTimes(2);
        expect(disposeRole).toHaveBeenCalledOnce();
        roleChanged?.();
        expect(invalidate).toHaveBeenCalledTimes(2);

        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43), lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 2, sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance }));
        let settleLate: ((value: { dispose(): Promise<void> }) => void) | undefined;
        let settleLateCleanup: (() => void) | undefined;
        const lateCleanup = new Promise<void>(resolve => { settleLateCleanup = resolve; });
        const disposeLate = vi.fn(() => lateCleanup);
        const cancelled = new AbortController();
        const pending = observeTriageSourceSessionLinks({ v: 1, sessionId: 'session-a' }, invalidate, {
            ...context, signal: cancelled.signal,
            services: { ...context.services, actions: { ...context.services.actions,
                observeAdmittedTargetedOperation: async () => await new Promise<{ dispose(): Promise<void> }>(resolve => { settleLate = resolve; }),
            } },
        });
        await vi.waitFor(() => expect(settleLate).toBeTypeOf('function'));
        cancelled.abort();
        settleLate?.({ dispose: disposeLate });
        let lateSettled = false;
        const late = pending.then(handle => { lateSettled = true; return handle; });
        await vi.waitFor(() => expect(disposeLate).toHaveBeenCalledOnce());
        expect(lateSettled).toBe(false);
        settleLateCleanup?.();
        await (await late).dispose();
        expect(disposeLate).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
    });

    it('ignores unrelated Session mutations, invalidates selected mutations once, and retires on disposal', async () => {
        const { collections, watchableCollections, control } = createTestkitCorpusCollections();
        const instance = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43), lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance }));
        // The persistence and admitted-registry transports are the only boundaries.
        const context = { surface: 'ui', caller: { kind: 'plugin', pluginId: 'happier.triage' }, signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? watchableCollections.sessionLinks : watchableCollections.sourceInstances } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => testkitReadOnlySourceSnapshot(), dispose() {} }) },
                actions: { executeAdmittedTargetedOperation: async () => { throw new Error('No source role was declared'); } },
            },
        } as unknown as TriageDataActionContext;
        const invalidate = vi.fn();
        const observer = await observeTriageSourceSessionLinks({ v: 1, sessionId: 'selected-session' }, invalidate, context);
        const write = (sessionId: string, entryId: string) => linkEntryToSession({ collections, entryRef: testkitEntryRef({ kindId: 'issue', entryId }),
            sessionId, display: { locator: { v: 1, displayPath: `Issue ${entryId}` }, scopeLabel: 'example/repository' }, nowMs: 1 });
        await write('unrelated-session', '1');
        expect(invalidate).not.toHaveBeenCalled();
        await write('selected-session', '2');
        expect(invalidate).toHaveBeenCalledOnce();
        // Configuration removal rebuilds membership while retaining the
        // admitted non-owned corpus slice for this Session.
        control.sourceInstances.tombstone('a'.repeat(43));
        await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
        const afterConfiguration = invalidate.mock.calls.length;
        await write('selected-session', '3');
        expect(invalidate).toHaveBeenCalledTimes(afterConfiguration + 1);
        await observer.dispose();
        const afterDisposal = invalidate.mock.calls.length;
        await write('selected-session', '4');
        expect(invalidate).toHaveBeenCalledTimes(afterDisposal);
    });
});

import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginActionHandlerUnavailableFixture } from '@happier-dev/plugin-sdk/testing';
import { testkitTriageActionId } from './testkit/entrySessionTestkit.test-support.js';
import { createTriageBulkEntrySessionsController, type TriageBulkHostV1, type TriageBulkSessionsRequestV1 } from './bulkEntrySessionsController.js';
import { TriageRunConfiguredActionInputV1Schema } from '../actions/configuredActionRunProtocol.js';
import { TriageStartEntrySessionInputV1Schema } from '../actions/entrySessionProtocol.js';
import { TRIAGE_DEFAULT_ACTIONS_V1 } from '../settings/actions.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
const entryRef = testkitEntryRef();
const request: TriageBulkSessionsRequestV1 = { action: TRIAGE_DEFAULT_ACTIONS_V1.find(action => action.actionId === 'fix')!,
    destination: 'oneSessionPerEntry', entries: [{ key: 'entry-one', entryRef, workflowSubject: 'issue',
        display: { scopeLabel: 'example/repository', locator: { v: 1 } },
        sourceInstance: { source: entryRef.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' }, presentation: { label: 'One issue' } }], unavailableKeys: ['missing-row'] };
describe('bulk host Action control preparation', () => {
    it('keeps pre-handler admission refusal and the original key available for explicit recovery', async () => {
        const creationKeys: string[] = [];
        let admissionRefused = true;
        const executeAction = async (ref: unknown, input: unknown) => {
            const actionId = testkitTriageActionId(ref);
            if (actionId === 'projects.list') return { items: [], truncated: false };
            if (actionId === 'actions/read-v1') return { v: 1, availability: 'parsed', revision: '1', actions: [request.action] };
            if (actionId === 'sessions/start-entry-v1') {
                const start = TriageStartEntrySessionInputV1Schema.parse(input);
                if (start.destination.kind !== 'new') throw new Error('Expected a new Session');
                creationKeys.push(start.destination.creationKey);
                if (admissionRefused) throw createPluginActionHandlerUnavailableFixture();
                throw new Error('An actually dispatched request lost its answer');
            }
            throw new Error('Unexpected host Action: ' + actionId);
        };
        const owner = createTriageBulkEntrySessionsController({ executeAction } as unknown as TriageBulkHostV1);
        try {
            owner.getSnapshot().run({ ...request, settlementForEntries: () => ({
                executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } },
                directory: { kind: 'path', path: '/workspaces/example' },
            }) });
            await owner.waitForSettled();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled', results: [{ status: 'notStarted' }],
                failure: { codes: ['plugin_action_handler_missing'] } });
            expect(owner.getRecovery()?.units[0]?.result).toMatchObject({ status: 'notStarted', creationKey: creationKeys[0] });
            admissionRefused = false;
            owner.getSnapshot().retry();
            await owner.waitForSettled();
            expect(creationKeys).toHaveLength(2);
            expect(creationKeys[1]).toBe(creationKeys[0]);
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled', results: [{ status: 'unknownOutcome' }] });
            const phase = owner.getSnapshot().phase;
            expect(phase.kind === 'settled' ? phase.failure : 'not settled').toBeUndefined();
        } finally { owner.dispose(); }
    });
    it('retains a typed partial bulk failure at physical Action settlement', async () => {
        const owner = createTriageBulkEntrySessionsController({} as TriageBulkHostV1);
        try {
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'success', result: {
                v: 1, handoff: { kind: 'entryExecution', status: 'bulk' }, status: 'bulk', results: [],
                failure: { codes: ['catalog_busy'], requestId: 'bulk-partial-17' },
            } });
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled',
                failure: { codes: ['catalog_busy'], requestId: 'bulk-partial-17' } });
        } finally { owner.dispose(); }
    });
    it('clears a prior typed retry failure after the next retry completes', async () => {
        let catalogAvailable = false;
        const executeAction = vi.fn(async (ref: unknown) => {
            const actionId = testkitTriageActionId(ref);
            if (actionId === 'projects.list') return { items: [], truncated: false };
            if (actionId === 'actions/read-v1') {
                if (!catalogAvailable) throw new PluginError({ code: 'catalog_busy', details: { requestId: 'bulk-retry-17' } });
                return { v: 1, availability: 'parsed', revision: '1', actions: [request.action] };
            }
            if (actionId === 'sessions/start-entry-v1') throw new Error('The dispatched unit has an unknown outcome');
            throw new Error('Unexpected Action: ' + actionId);
        });
        // The host Action transport is the system boundary; the real controller owns retry and settlement.
        const owner = createTriageBulkEntrySessionsController({ executeAction } as unknown as TriageBulkHostV1);
        try {
            owner.getSnapshot().run({ ...request, settlementForEntries: () => ({
                executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } },
                directory: { kind: 'path', path: '/workspaces/example' },
            }) });
            await owner.waitForSettled();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled', results: [{ status: 'unknownOutcome' }] });
            owner.getSnapshot().retry();
            await owner.waitForSettled();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled',
                failure: { codes: ['catalog_busy'], requestId: 'bulk-retry-17' } });
            catalogAvailable = true;
            owner.getSnapshot().retry();
            await owner.waitForSettled();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled', results: [{ status: 'unknownOutcome' }] });
            const phase = owner.getSnapshot().phase;
            expect(phase.kind === 'settled' ? phase.failure : 'not settled').toBeUndefined();
        } finally { owner.dispose(); }
    });
    it('replaces physical outcomes when automation starts a different bulk run', async () => {
        const owner = createTriageBulkEntrySessionsController({} as TriageBulkHostV1);
        try {
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'success', result: { v: 1, handoff: { kind: 'entryExecution', status: 'bulk' }, status: 'bulk', results: [] } });
            owner.getSnapshot().run({ ...request, entries: [] });
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'noEntriesAvailable' });
            expect(owner.getSnapshot().configuredResult).toBeNull();
        } finally { owner.dispose(); }
    });
    it('does not silently clear an admitted run when its gesture lifetime is aborted', async () => {
        const owner = createTriageBulkEntrySessionsController({} as TriageBulkHostV1);
        const lifetime = new AbortController();
        try {
            await owner.getSnapshot().prepareAction(request, { signal: lifetime.signal });
            lifetime.abort();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'handoffOutcomeUnknown' });
            expect(owner.getSnapshot().retryable).toBe(false);
            expect(await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal })).toBeNull();
        } finally { owner.dispose(); }
    });
    it('prepares the entire selected run without invoking units and preserves skipped selected keys on settlement', async () => {
        const executeAction = vi.fn(async () => { throw Error('Only a physical host press invokes'); });
        const owner = createTriageBulkEntrySessionsController({ executeAction } as unknown as TriageBulkHostV1);
        try {
            const prepared = await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            const input = TriageRunConfiguredActionInputV1Schema.parse(prepared?.input);
            expect(input.handoff.context).toEqual({ kind: 'entries', destination: 'oneSessionPerEntry',
                entries: [{ entryRef, sourceInstanceId: request.entries[0]!.sourceInstance.sourceInstanceId }] });
            expect(executeAction).not.toHaveBeenCalled();
            owner.getSnapshot().settleAction({ status: 'success', result: { v: 1, handoff: { kind: 'entryExecution', status: 'bulk' }, status: 'bulk',
                results: [{ creationKey: 'creation-one', entryRefs: [entryRef], status: 'notStarted' }] } });
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'settled', selectionKeys: ['entry-one', 'missing-row'], unavailableKeys: ['missing-row'],
                results: [{ status: 'notStarted', unit: { creationKey: 'creation-one', entries: [request.entries[0]] } }] });
            const lastSettlement = owner.getSnapshot().phase;
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'outcomeUnknown', code: 'timeout', message: 'Lost response' });
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'handoffOutcomeUnknown', lastSettlement });
            expect(owner.getSnapshot().retryable).toBe(false);
        } finally { owner.dispose(); }
    });
});

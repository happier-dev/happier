import { describe, expect, it, vi } from 'vitest';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriageEntrySessionStartRequestV1 } from './entrySessionStartController.js';
import { TriageRunConfiguredActionInputV1Schema } from '../actions/configuredActionRunProtocol.js';
import { TRIAGE_DEFAULT_ACTIONS_V1 } from '../settings/actions.js';
import { describeTriageEntrySessionPhaseV1 } from '../ui/header/sessionStartOutcome.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';

const request: TriageEntrySessionStartRequestV1 = {
    action: TRIAGE_DEFAULT_ACTIONS_V1.find(action => action.actionId === 'fix')!,
    entryRef: testkitEntryRef(), display: { scopeLabel: 'example/repository', locator: { v: 1 } },
    sourceInstance: { source: testkitEntryRef().source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
    presentation: { label: 'Example issue' },
};
describe('Session start host-control preparation', () => {
    it('replaces physical outcomes when automation starts a different run', async () => {
        const owner = createTriageEntrySessionStartController({} as TriageStartHostV1);
        try {
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'success', result: { v: 1, handoff: { kind: 'entryExecution', status: 'seeded' }, status: 'seeded' } });
            owner.getSnapshot().start({ ...request, action: { ...request.action,
                target: { kind: 'agent', delivery: 'send', promptInvocationId: null } } });
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'instructionMissing' });
            expect(owner.getSnapshot().configuredResult).toBeNull();
        } finally { owner.dispose(); }
    });
    it('allows a fresh physical preparation after a settled host refusal', async () => {
        const owner = createTriageEntrySessionStartController({} as TriageStartHostV1);
        try {
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'error', code: 'denied', message: 'Permission denied', retryable: false });
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'dispatch' });
            expect(await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal })).not.toBeNull();
        } finally { owner.dispose(); }
    });
    it('preserves known outcomes and refuses another start after the outer response is lost', async () => {
        const owner = createTriageEntrySessionStartController({} as TriageStartHostV1);
        const known = { v: 1, handoff: { kind: 'entryExecution', status: 'seeded' }, status: 'seeded' } as const;
        try {
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'success', result: known });
            await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            owner.getSnapshot().settleAction({ status: 'outcomeUnknown', code: 'timeout', message: 'Lost outer response' });
            expect(owner.getSnapshot().configuredResult).toEqual(known);
            expect(await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal })).toBeNull();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'handoffOutcomeUnknown' });
        } finally { owner.dispose(); }
    });
    it('reports an aborted prepared gesture as unknown instead of saying nothing started', async () => {
        const owner = createTriageEntrySessionStartController({} as TriageStartHostV1);
        const lifetime = new AbortController();
        try {
            await owner.getSnapshot().prepareAction(request, { signal: lifetime.signal });
            lifetime.abort();
            expect(owner.getSnapshot().phase).toMatchObject({ kind: 'unavailable', reason: 'handoffOutcomeUnknown' });
            expect(await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal })).toBeNull();
        } finally { owner.dispose(); }
    });
    it('prepares one configured run and consumes its recovery without a raw start invocation', async () => {
        const executeAction = vi.fn(async () => { throw Error('A host press alone executes the prepared Action'); });
        const owner = createTriageEntrySessionStartController({ executeAction } as unknown as TriageStartHostV1);
        try {
            const prepared = await owner.getSnapshot().prepareAction(request, { signal: new AbortController().signal });
            const parsed = TriageRunConfiguredActionInputV1Schema.parse(prepared?.input);
            expect(parsed.handoff.context).toEqual({ kind: 'entries', entries: [{ entryRef: request.entryRef,
                sourceInstanceId: request.sourceInstance.sourceInstanceId }], destination: 'single' });
            expect(executeAction).not.toHaveBeenCalled();
            owner.getSnapshot().settleAction({ status: 'success', result: { v: 1, handoff: { kind: 'entryExecution', status: 'seeded' }, status: 'seeded' } });
            expect(owner.getSnapshot().authoringResult).toBe('seeded');
            expect(describeTriageEntrySessionPhaseV1(owner.getSnapshot().phase)).toBeNull();
            expect(owner.getSnapshot().phase.kind).toBe('handoffSettled');
        } finally { owner.dispose(); }
    });
    it('settles cancelled destination selection without invoking or retaining a busy phase', async () => {
        const executeAction = vi.fn(async (id: unknown) => {
            if (id === 'session.list') return { sessions: [], hasNext: false };
            throw Error('Cancelled preparation cannot invoke');
        });
        const owner = createTriageEntrySessionStartController({ executeAction,
            readSession: async () => null,
            selectActionInput: async () => ({ kind: 'cancelled' }),
        } as unknown as TriageStartHostV1);
        try {
            expect(await owner.getSnapshot().prepareAction({ ...request, destinationChoice: 'existingSession' },
                { signal: new AbortController().signal })).toBeNull();
            expect(owner.getSnapshot().phase.kind).toBe('idle');
            expect(executeAction.mock.calls.every(([id]) => id === 'session.list')).toBe(true);
        } finally { owner.dispose(); }
    });
});

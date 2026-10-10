import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowRunListFilter, listWorkflowRuns } from './workflowRunListActions';
import { WorkflowActionError } from './workflowActionError';

const executeMock = vi.hoisted(() => vi.fn());

// Third-party rendering boundary; this Action client does not render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => executeMock,
}));

describe('workflow Run list Action client', () => {
    it('uses exact Automation history and active Session destinations in the shared paged reader', async () => {
        executeMock.mockResolvedValue({ ok: true, result: { runs: [], metadataByRunId: {} } });
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('automation:habit') });
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('destination:session-one') });
        expect(executeMock.mock.calls[0]?.[1]).toEqual({ automationId: 'habit' });
        expect(executeMock.mock.calls[1]?.[1]).toEqual({ targetSessionId: 'session-one',
            states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] });
    });
    beforeEach(() => {
        executeMock.mockReset();
    });

    it('reads a page through the canonical list Action and parses its result', async () => {
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: { runs: [createWorkflowRunSummaryFixture({ id: 'run-1' })], metadataByRunId: {}, nextCursor: 'cursor-2' },
        });

        const page = await listWorkflowRuns({ cursor: 'cursor-1', limit: 20 });

        const [actionId, input] = executeMock.mock.calls[0]!;
        expect(actionId).toBe('workflow.run.list');
        expect(input).toEqual({ cursor: 'cursor-1', limit: 20 });
        expect(page.runs[0]?.id).toBe('run-1');
        expect(page.nextCursor).toBe('cursor-2');
    });

    it('preserves a readable untitled Run as sparse metadata instead of densifying it into unavailable', async () => {
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-1' }),
                    createWorkflowRunSummaryFixture({ id: 'run-2' }),
                ],
                metadataByRunId: {
                    'run-1': { kind: 'available', value: { title: 'Review 500 files' } },
                },
            },
        });

        const page = await listWorkflowRuns();

        // The producer omits the key when the accepted snapshot opened
        // cleanly but carries no authored title. That absence is a readable
        // untitled Run — the canonical display projector names it Untitled —
        // while only an explicit `unavailable` earns the lock treatment.
        expect(page.metadataByRunId).toEqual({
            'run-1': { kind: 'available', value: { title: 'Review 500 files' } },
            'run-2': null,
        });
    });

    it('keeps explicit unavailable metadata unavailable', async () => {
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                runs: [createWorkflowRunSummaryFixture({ id: 'run-1' })],
                metadataByRunId: { 'run-1': { kind: 'unavailable' } },
            },
        });

        const page = await listWorkflowRuns();

        expect(page.metadataByRunId).toEqual({ 'run-1': { kind: 'unavailable' } });
    });

    it('rejects an incomplete current list response without its metadata map', async () => {
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-1' }),
                    createWorkflowRunSummaryFixture({ id: 'run-2' }),
                ],
            },
        });

        await expect(listWorkflowRuns()).rejects.toThrow();
    });

    it('asks the server for attention rather than scanning a cached page', async () => {
        executeMock.mockResolvedValueOnce({ ok: true, result: { runs: [], metadataByRunId: {} } });

        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('attention') });

        expect(executeMock.mock.calls[0]![1]).toEqual({ attention: 'required' });
    });

    it('raises the one canonical workflow error with its closed code, not a generic Error', async () => {
        executeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'run_access_denied',
            error: 'That Account cannot read this run.',
        });

        const failure = await listWorkflowRuns().then(() => null, (error: unknown) => error);

        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBe('run_access_denied');
        expect((failure as Error).message).toBe('That Account cannot read this run.');
    });

    it('keeps an unrecognized transport failure uncoerced instead of inventing a workflow code', async () => {
        executeMock.mockResolvedValueOnce({ ok: false, errorCode: 'transport_closed', error: 'Connection lost.' });

        const failure = await listWorkflowRuns().then(() => null, (error: unknown) => error);

        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBeNull();
        expect((failure as InstanceType<typeof WorkflowActionError>).rawCode).toBe('transport_closed');
    });

    it('rejects a malformed list response instead of handing it to a screen', async () => {
        executeMock.mockResolvedValueOnce({ ok: true, result: { runs: [{ id: 'run-1' }] } });

        await expect(listWorkflowRuns()).rejects.toThrow();
    });

    it('maps the Active filter onto canonical nonterminal states only', async () => {
        const active = buildWorkflowRunListFilter('active');
        expect(active.states).toBeDefined();
        expect(active.states).not.toContain('succeeded');
        expect(active.states).not.toContain('cancelled');
        expect(buildWorkflowRunListFilter('all')).toEqual({});
    });

    it('reads one exact Run summary through the list owner without touching detail', async () => {
        const { getWorkflowRunSummary } = await import('./workflowRunListActions');
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                runs: [createWorkflowRunSummaryFixture({ id: 'run-1' })],
                metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Review 500 files' } } },
            },
        });

        const summary = await getWorkflowRunSummary('run-1');

        const [actionId, input] = executeMock.mock.calls[0]!;
        expect(actionId).toBe('workflow.run.list');
        expect(input).toEqual({ runId: 'run-1', limit: 1 });
        expect(summary.run.id).toBe('run-1');
        expect(summary.metadata).toEqual({ kind: 'available', value: { title: 'Review 500 files' } });
    });

    it('reports a deleted exact Run as run_not_found so the row is removed', async () => {
        const { getWorkflowRunSummary } = await import('./workflowRunListActions');
        executeMock.mockResolvedValueOnce({ ok: true, result: { runs: [], metadataByRunId: {} } });

        const failure = await getWorkflowRunSummary('run-1').then(() => null, (error: unknown) => error);

        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBe('run_not_found');
    });

    it('keeps an exact readable untitled Run unnamed rather than unavailable', async () => {
        const { getWorkflowRunSummary } = await import('./workflowRunListActions');
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: { runs: [createWorkflowRunSummaryFixture({ id: 'run-1' })], metadataByRunId: {} },
        });

        const summary = await getWorkflowRunSummary('run-1');

        expect(summary.metadata).toBeNull();
    });

    it('keeps an exact unavailable Run unavailable', async () => {
        const { getWorkflowRunSummary } = await import('./workflowRunListActions');
        executeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                runs: [createWorkflowRunSummaryFixture({ id: 'run-1' })],
                metadataByRunId: { 'run-1': { kind: 'unavailable' } },
            },
        });

        const summary = await getWorkflowRunSummary('run-1');

        expect(summary.metadata).toEqual({ kind: 'unavailable' });
    });
});

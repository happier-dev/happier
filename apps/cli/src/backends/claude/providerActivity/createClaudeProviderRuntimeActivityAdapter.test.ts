import { describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeActivityContribution } from '@/session/runtimeActivity/types';
import { createClaudeProviderActivityLedger } from './createClaudeProviderActivityLedger';
import {
    createClaudeProviderRuntimeActivityAdapter,
    createClaudeProviderRuntimeActivityBindingOwner,
} from './createClaudeProviderRuntimeActivityAdapter';

function harness() {
    const reports: SessionRuntimeActivityContribution[] = [];
    const markUnknown = vi.fn(async (_reason: string) => {});
    const ledger = createClaudeProviderActivityLedger();
    const adapter = createClaudeProviderRuntimeActivityAdapter({
        providerActivityLedger: ledger,
        contributionHandle: {
            report: vi.fn(async (value) => { reports.push(value); }),
            markUnknown,
            dispose: vi.fn(async () => {}),
        },
    });
    return { adapter, ledger, reports, markUnknown };
}

describe('createClaudeProviderRuntimeActivityAdapter', () => {
    it('fences the prior production binding without publishing before its observer is installed', async () => {
        const contributionHandle = {
            report: vi.fn(async () => {}),
            markUnknown: vi.fn(async () => {}),
            dispose: vi.fn(async () => {}),
        };
        const owner = createClaudeProviderRuntimeActivityBindingOwner(contributionHandle);

        const first = await owner.activate();
        expect(first.isCurrentRuntime()).toBe(true);
        expect(contributionHandle.report).not.toHaveBeenCalled();
        const replacement = await owner.activate();

        expect(first.isCurrentRuntime()).toBe(false);
        expect(replacement.isCurrentRuntime()).toBe(true);
        expect(contributionHandle.report).not.toHaveBeenCalled();
        expect(contributionHandle.markUnknown).not.toHaveBeenCalled();
        owner.invalidate();
        expect(replacement.isCurrentRuntime()).toBe(false);
    });

    it('offers the latest complete initial state only after observer installation', async () => {
        const { adapter, reports } = harness();

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'installation-window-task' },
            evidence: 'live',
        });

        expect(reports).toEqual([]);
        await adapter.activateObservation('claude-provider-observer-installed');
        expect(reports).toEqual([{ state: 'active', activeCount: 1 }]);
    });

    it('does not replace an installation-window observation loss with blind idle', async () => {
        const { adapter, reports, markUnknown } = harness();

        await adapter.handleRuntimeLoss('scanner-lost-during-install');
        expect(reports).toEqual([]);
        expect(markUnknown).not.toHaveBeenCalled();

        await adapter.activateObservation('observer-installed');
        expect(reports).toEqual([]);
        expect(markUnknown).toHaveBeenCalledWith('observer-installed');
    });

    it('reconciles evidence arriving while the initial observer offer is pending', async () => {
        let releaseInitial = (): void => {};
        const initialPending = new Promise<void>((resolve) => { releaseInitial = resolve; });
        const reports: SessionRuntimeActivityContribution[] = [];
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: createClaudeProviderActivityLedger(),
            contributionHandle: {
                report: vi.fn(async (value) => {
                    reports.push(value);
                    if (reports.length === 1) await initialPending;
                }),
                markUnknown: vi.fn(async () => {}),
                dispose: vi.fn(async () => {}),
            },
        });

        const activation = adapter.activateObservation('observer-installed');
        await vi.waitFor(() => expect(reports).toEqual([{ state: 'idle', activeCount: 0 }]));
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'during-install' }, evidence: 'live',
        });
        releaseInitial();
        await activation;

        expect(reports).toEqual([
            { state: 'idle', activeCount: 0 },
            { state: 'active', activeCount: 1 },
        ]);
    });

    it('never publishes again after the initial observer offer rejects', async () => {
        const report = vi.fn(async () => { throw new Error('offer rejected'); });
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: createClaudeProviderActivityLedger(),
            contributionHandle: {
                report,
                markUnknown: vi.fn(async () => {}),
                dispose: vi.fn(async () => {}),
            },
        });

        await expect(adapter.activateObservation('observer-installed')).rejects.toThrow('offer rejected');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'after-failure' }, evidence: 'live',
        });
        await adapter.publishCurrent('after-failure');

        expect(report).toHaveBeenCalledTimes(1);
    });

    it('projects the current-runtime inventory and returns to idle after the last exact terminal', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'same' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's2', taskId: 'same' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 'same' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's2', taskId: 'same' }, evidence: 'live',
        });

        expect(reports.map((value) => value.activeCount)).toEqual([0, 1, 2, 1, 0]);
        expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('uses unknown for same-runtime observation loss and keeps affirmative truth for live evidence', async () => {
        const { adapter, ledger, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'historical-replay',
        });
        expect(ledger.hasActiveProviderTasks()).toBe(false);
        await adapter.handleRuntimeLoss('unavailable');
        expect(markUnknown).toHaveBeenLastCalledWith('unavailable');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
        expect(ledger.hasActiveProviderTasks()).toBe(true);
    });

    it('publishes unknown when observation is lost while provider tasks are still in flight', async () => {
        const { adapter, ledger, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'subagent-1' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 2 });

        await adapter.handleRuntimeLoss('claude_agent_sdk_stream_finalized');

        // The query that owned those tasks is gone: a non-empty ledger is evidence of ignorance,
        // not of liveness, so the session must project unknown rather than stay active forever.
        expect(markUnknown).toHaveBeenLastCalledWith('claude_agent_sdk_stream_finalized');
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 2 });
        // Inventory evidence is preserved for blocker diagnostics; only the projection changes.
        expect(ledger.hasActiveProviderTasks()).toBe(true);
    });

    it('does not republish a projection after an in-flight observation loss already marked unknown', async () => {
        const { adapter, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        });
        await adapter.handleRuntimeLoss('claude_process_exit');
        expect(markUnknown).toHaveBeenCalledTimes(1);

        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        });

        expect(markUnknown).toHaveBeenCalledTimes(1);
    });

    it('does not republish an unchanged tuple inventory for progress aliases', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'progress', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });

        expect(reports.map((value) => value.activeCount)).toEqual([0, 1]);
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('keeps an untracked terminal inert instead of publishing synthetic unknown', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');

        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 'wrong-session', taskId: 'missing' },
            evidence: 'live',
        });

        expect(reports).toEqual([{ state: 'idle', activeCount: 0 }]);
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('serializes projection writes and fences queued callbacks from a stale runtime', async () => {
        let current = true;
        let releaseFirstReport = (): void => {
            throw new Error('first report was not armed');
        };
        const firstReportPending = new Promise<void>((resolve) => {
            releaseFirstReport = resolve;
        });
        const ledger = createClaudeProviderActivityLedger();
        const report = vi.fn(async () => {
            await firstReportPending;
        });
        const markUnknown = vi.fn(async () => {});
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: ledger,
            contributionHandle: {
                report,
                markUnknown,
                dispose: vi.fn(async () => {}),
            },
            isCurrentRuntime: () => current,
        });

        const activation = adapter.activateObservation('observer-installed');
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
        releaseFirstReport();
        await activation;

        let releaseActiveReport = (): void => {
            throw new Error('active report was not armed');
        };
        const activeReportPending = new Promise<void>((resolve) => {
            releaseActiveReport = resolve;
        });
        report.mockImplementationOnce(async () => {
            await activeReportPending;
        });

        const started = adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'task-1' }, evidence: 'live',
        });
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
        const terminal = adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 'task-1' }, evidence: 'live',
        });

        expect(markUnknown).not.toHaveBeenCalled();
        current = false;
        releaseActiveReport();
        await Promise.all([started, terminal]);

        expect(report).toHaveBeenCalledTimes(2);
        expect(markUnknown).not.toHaveBeenCalled();
        expect(ledger.hasActiveProviderTasks()).toBe(false);
    });

    it('keeps inventory truth when projection publication rejects', async () => {
        const ledger = createClaudeProviderActivityLedger();
        const report = vi.fn(async () => {
            if (report.mock.calls.length === 2) throw new Error('publish failed');
        });
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: ledger,
            contributionHandle: {
                report,
                markUnknown: vi.fn(async () => {}),
                dispose: vi.fn(async () => {}),
            },
        });
        await adapter.activateObservation('observer-installed');
        await expect(adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        })).rejects.toThrow('publish failed');
        expect(ledger.hasActiveProviderTasks()).toBe(true);
        await expect(adapter.observeActivity({
            activity: { type: 'progress', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        })).resolves.toBeUndefined();
        expect(report).toHaveBeenCalledTimes(3);
    });
});

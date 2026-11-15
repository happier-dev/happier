import { describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

/**
 * The exact daemon's targeted-contribution read is a Machine RPC (a genuine process boundary);
 * the wrapper only counts calls and keeps the real reader beneath it.
 */
const contributionReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (original) => {
    const actual = await original<typeof import('@/sync/ops/machineContributionRegistryProjection')>();
    return {
        ...actual,
        machinePluginUiTargetedContributionsRead: (async (...args: Parameters<typeof actual.machinePluginUiTargetedContributionsRead>) => {
            contributionReads.count += 1;
            return await actual.machinePluginUiTargetedContributionsRead(...args);
        }) as typeof actual.machinePluginUiTargetedContributionsRead,
    };
});
/** Observes the deps the app hands the canonical protocol executor; the executor itself is unchanged. */
const builtDeps = vi.hoisted(() => ({ latest: null as ActionExecutorDeps | null }));
vi.mock('@happier-dev/protocol/actions/actionExecutor', async (original) => {
    const actual = await original<typeof import('@happier-dev/protocol/actions/actionExecutor')>();
    return {
        ...actual,
        createActionExecutor: ((deps: ActionExecutorDeps) => {
            builtDeps.latest = deps;
            return actual.createActionExecutor(deps);
        }) as typeof actual.createActionExecutor,
    };
});

// Only HTTP, credentials and the disconnected socket boundary are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { withDefaultActionExecuteContext } = await import('./defaultActionExecutor');

describe('plugin-origin approval execution (plugins are trusted code)', () => {
    it('admits an approved plugin-origin live invocation without reading the plugin source, across an equal-input plugin update', async () => {
        await homes.reset();
        await loadSyncSingletonForTests();
        const serverId = await homes.addHome({ name: 'Plugin Home', serverUrl: 'https://plugin-origin.test',
            serverIdentityId: 'srv_plugin_origin', accountId: 'owner', currentAccount: true });
        try {
            await withDefaultActionExecuteContext(undefined, { serverId }, async (_executor, account) => {
                const deps = builtDeps.latest;
                if (!deps?.isApprovalExecutionOriginCurrent) throw new Error('Expected the app approval currentness owner');
                // Approved by the person under plugin generation 1; the plugin has since updated
                // (another generation) with the same Action and canonical input (ruling 2026-11-02).
                const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
                    createdBy: { surface: 'system' }, requestedSurface: 'plugin', approval: { flow: 'blocking', result: 'required' },
                    actionId: 'widgets.item.add', summary: 'Add widget', actionArgs: {
                        surface: { serverId, accountId: 'owner', owner: { kind: 'pluginArea', pluginId: 'acme.widgets', pageId: 'overview', area: 'pinned' } },
                        instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} },
                    },
                    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin',
                        caller: { kind: 'plugin', pluginId: 'acme.widgets', contributionLocalId: 'overview',
                            sourceCustody: { kind: 'development', registeredRootId: 'widgets-generation-1' } },
                        serverId: account.serverId, ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
                        accountId: account.accountId, machineId: 'admitted', actionId: 'widgets.item.add', requestId: 'add' },
                    decision: { kind: 'approve', decidedAtMs: 2 } });
                expect(resolveApprovalExecutor(request)).toEqual({ kind: 'live_invocation' });
                contributionReads.count = 0;
                const stale: string[] = [];
                const current = await deps.isApprovalExecutionOriginCurrent({
                    origin: request.executionOriginV1, request, reportStale: reason => { stale.push(reason); } });
                expect({ current, stale, contributionReads: contributionReads.count })
                    .toEqual({ current: true, stale: [], contributionReads: 0 });
            });
        } finally {
            await homes.reset();
        }
    });
});

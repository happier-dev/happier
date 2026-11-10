import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ProjectReadinessReadInputV1Schema, type ProjectReadinessReadInputV1 } from '@happier-dev/protocol/projects/readinessV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await import('@/sync/ops/actions/defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useProjectReadiness } = await import('./useProjectReadiness');

describe('Project Readiness presentation demand', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());
    it('reads only a selected visible Environment, refreshes explicitly, and drops its previous facts on switch', async () => {
        const identity = `srv_${'6'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness-widget.test',
            serverIdentityId: identity, accountId: 'alice', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        const reads: ProjectReadinessReadInputV1[] = [];
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'controller',
            actionId: 'projects.readiness.read', requesterInvocation: 'none', tokenEpoch: 0, execute: raw => {
                const input = ProjectReadinessReadInputV1Schema.parse(raw);
                reads.push(input);
                return { serverId: identity, projectId: input.projectId, status: 'unavailable', facts: [
                    { kind: 'ci', owner: 'forgeCI', status: 'unavailable', reason: 'ci_source_unavailable' },
                    { kind: 'backups', owner: 'deploymentBackups', environmentId: input.environments[0]!.environmentId,
                        status: 'actionNeeded', reason: 'backup_policy_missing' },
                ] };
            } });
        let visible = false;
        let input: ProjectReadinessReadInputV1 | null = null;
        const hook = await renderHook(() => useProjectReadiness(account.accountLifetime, input, visible));
        try {
            expect(reads).toHaveLength(0);
            input = { serverId: identity, machineId: 'controller', projectId: 'project',
                environments: [{ environmentId: 'production', expectedRevision: 4 }] };
            await hook.rerender();
            expect(reads).toHaveLength(0);
            visible = true;
            await hook.rerender();
            await vi.waitFor(() => expect(hook.getCurrent().result?.facts[1]?.environmentId, JSON.stringify({
                pending: hook.getCurrent().pending, failureCode: hook.getCurrent().failureCode, reads,
                current: account.accountLifetime.isCurrent(),
                requests: homes.requests.map(request => ({ method: request.method, path: request.path, input: request.input })),
            })).toBe('production'));
            expect(reads).toHaveLength(1);
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(reads).toHaveLength(2);
            input = { ...input, environments: [{ environmentId: 'staging', expectedRevision: 8 }] };
            await hook.rerender();
            expect(hook.getCurrent().result?.facts.some(fact => fact.environmentId === 'production')).not.toBe(true);
            await vi.waitFor(() => expect(hook.getCurrent().result?.facts[1]?.environmentId).toBe('staging'));
            expect(reads).toHaveLength(3);
            expect(reads[2]).toEqual(input);
            visible = false;
            await hook.rerender();
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(reads).toHaveLength(3);
            expect(homes.requests.filter(request => request.path.includes('/sessions'))).toEqual([]);
        } finally { await hook.unmount(); account.dispose(); }
    });
});

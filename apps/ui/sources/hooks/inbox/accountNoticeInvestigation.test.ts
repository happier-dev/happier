import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountNoticeArtifactFixture, createServiceHealthNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createAccountNoticeInvestigation, failureInvestigationSubjectKey } from './accountNoticeInvestigation';
import { TriageFailureSubjectV1Schema } from '@happier-dev/triage-protocol/v1';

describe('private notice investigation through the Action front door', () => {
    it('offers the authored restart on a retained service notice in its Home', () => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const service = { kind: 'deployment', machineId: 'machine', environmentId: 'environment',
            environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } as const;
        const choice = { actionId: 'deployments.restart', label: 'Restart service', input: {
            serverId: scope.serverId, environmentId: service.environmentId, deploymentId: 'current',
            targetLinkId: 'runtime', machineId: service.machineId, installationId: 'installation', service,
            expectedGeneration: 'native-generation' } } as const;
        const artifact = createServiceHealthNoticeArtifactFixture(scope.serverId, { header: { recoveryChoices: [choice] } });
        const entry = { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture()));
        const owner = createAccountNoticeInvestigation({ scope, isCurrent: () => true, execute });
        expect(owner.readRecoveryChoices(entry)).toEqual([choice]);
        const foreign = createAccountNoticeInvestigation({ scope: { ...scope, serverId: 'other-home' }, isCurrent: () => true, execute });
        expect(foreign.readRecoveryChoices(entry)).toEqual([]);
    });
    it('keeps pending investigations distinct for exact Workflow Runs and Homes', () => {
        const subject = TriageFailureSubjectV1Schema.parse({ kind: 'workflowRun', serverId: 'home', runId: 'run-a' });
        expect(failureInvestigationSubjectKey(subject)).not.toBe(failureInvestigationSubjectKey(
            TriageFailureSubjectV1Schema.parse({ ...subject, runId: 'run-b' })));
        expect(failureInvestigationSubjectKey(subject)).not.toBe(failureInvestigationSubjectKey(
            TriageFailureSubjectV1Schema.parse({ ...subject, serverId: 'other-home' })));
    });
    it('uses a non-Triage contribution for launch, editor and a retained relationship after remount', async () => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'env', deploymentId: 'receipt' } as const;
        const binding = { pluginId: 'acme.investigation', action: 'failure/handle' };
        const calls: Array<{ action: unknown; input: unknown }> = [];
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            invokeContributedAction: async request => {
                calls.push({ action: request.action, input: request.input });
                const input = request.input as { kind: string };
                return { ok: true, result: input.kind === 'launch' ? { kind: 'presentation', outcome: { kind: 'started' } }
                    : input.kind === 'edit' ? { kind: 'edited' }
                    : { kind: 'linkedSession', session: { serverId: scope.serverId, sessionId: 'linked-investigation' } } };
            },
        })));
        const makeOwner = () => createAccountNoticeInvestigation({ scope, binding, isCurrent: () => true, execute });
        const owner = makeOwner();
        expect(await owner.launch(subject, { actionId: 'diagnose', delivery: 'compose' })).toEqual({ kind: 'started' });
        await owner.openEditor('diagnose');
        owner.dispose();
        expect(await makeOwner().readLinkedSession(subject)).toEqual({ serverId: scope.serverId, sessionId: 'linked-investigation' });
        expect(calls).toEqual([
            { action: { pluginId: binding.pluginId, localId: binding.action }, input: { kind: 'launch',
                context: { kind: 'failure', subject }, actionId: 'diagnose', delivery: 'compose' } },
            { action: { pluginId: binding.pluginId, localId: binding.action }, input: { kind: 'edit', actionId: 'diagnose' } },
            { action: { pluginId: binding.pluginId, localId: binding.action }, input: { kind: 'readLinkedSession', context: { kind: 'failure', subject } } },
        ]);
    });
    it('admits persisted provider evidence and refuses unowned, foreign Home and retired presses before transport', async () => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const selected = { entryRef: { source: { pluginId: 'acme.review', localId: 'issues' }, kindId: 'issue', collisionScope: 'project', entryId: '42' },
            sourceInstanceId: '11111111-1111-4111-8111-111111111111' };
        const artifact = createAccountNoticeArtifactFixture({ header: { investigation: { kind: 'alertEntry', entry: selected }, healthPhase: 'open' } });
        const entry = { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
        const inputs: unknown[] = [];
        let current = true;
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            invokeContributedAction: async request => { inputs.push(request.input); return { ok: true,
                result: { kind: 'presentation', outcome: { kind: 'selectionRequired', fields: ['placement'] } } }; },
        })));
        const owner = createAccountNoticeInvestigation({ scope, binding: { pluginId: 'acme.investigation', action: 'failure/handle' }, isCurrent: () => current, execute });
        expect(await owner.launch(entry, {})).toEqual({ kind: 'selectionRequired', fields: ['placement'] });
        expect(inputs).toEqual([{ kind: 'launch', context: { kind: 'entry', entry: selected } }]);
        expect(await owner.launch({ ...entry, artifact: { ...artifact, ownerAccountId: 'other-account' } }, {}))
            .toEqual({ kind: 'unavailable', code: 'action_account_scope_changed' });
        expect(await owner.launch({ kind: 'workflowRun', serverId: 'foreign', runId: 'run' }, {}))
            .toEqual({ kind: 'unavailable', code: 'action_account_scope_changed' });
        current = false;
        expect(await owner.launch(entry, {})).toEqual({ kind: 'unavailable', code: 'action_account_scope_changed' });
        expect(inputs).toHaveLength(1);
    });
    it.each(['machine_service', 'environment', 'resource_limit'] as const)('forwards exact %s evidence and explicit placement to its contribution', async page => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const resource = { topic: 'resource_limit', kind: 'cpu_busy', phase: 'started', machineId: 'resource-machine',
            at: 2_000, since: 1_000, guardEnabled: false, evidence: { abovePct: 90, sustainMs: 1_000, busyPct: 99 } } as const;
        const artifact = page === 'machine_service' ? createServiceHealthNoticeArtifactFixture(scope.serverId)
            : page === 'resource_limit' ? createUsageNoticeArtifactFixture({
                header: { v: 1, kind: 'usage_notice.v1', title: 'Machine needs attention', status: 'open', notice: resource },
                body: JSON.stringify({ v: 1, notice: resource }),
            }) : createAccountNoticeArtifactFixture({ header: {
                title: 'Platform deployment needs attention', type: 'blocked', healthPhase: 'open',
                source: { kind: 'host', topic: 'service_health', subject: { kind: 'platformTarget', environmentId: 'environment', targetLinkId: 'platform-link' } },
                page: { kind: 'host', page: 'environment', targetLinkId: 'platform-link',
                    environment: { serverId: scope.serverId, projectSourceId: 'project', environmentId: 'environment' } },
            } });
        const header = readAccountNoticeArtifactHeader(artifact, scope.accountId)!;
        const entry = { artifact, header };
        const placement = { machine: { serverId: scope.serverId, machineId: 'chosen-machine' } };
        const inputs: unknown[] = [];
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: async request => {
            inputs.push(request.input); return { ok: true, result: { kind: 'presentation', outcome: { kind: 'started' } } };
        } })));
        const owner = createAccountNoticeInvestigation({ scope, binding: { pluginId: 'acme.investigation', action: 'failure/handle' }, isCurrent: () => true, execute });
        expect(await owner.launch(entry, {}, { placement })).toEqual({ kind: 'started' });
        expect(inputs).toEqual([{ kind: 'launch', context: { kind: 'healthAlert',
            notice: { kind: 'host', artifactId: artifact.id, source: header.source },
            target: page === 'resource_limit' ? { kind: 'machine', machine: { serverId: scope.serverId, machineId: resource.machineId } } : header.page,
        }, placement }]);
    });
});

it('settles a receipt catalog acquisition when the client lifetime refuses it as a presentation', async () => {
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'environment', deploymentId: 'receipt' } as const;
    // A retired native-failure execution scope returns this declared presentation result.
    const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
        invokeContributedAction: async () => ({ ok: true, result: {
            kind: 'presentation', outcome: { kind: 'unavailable', code: 'action_account_scope_changed' },
        } }),
    })));
    const owner = createAccountNoticeInvestigation({ scope, isCurrent: () => true, execute,
        binding: { pluginId: 'happier.triage', action: 'native-failure/handle-v1' } });
    expect(await owner.readAgentActions(subject, true)).toEqual({ kind: 'unavailable', code: 'action_account_scope_changed' });
    expect(await owner.launch(subject, {})).toEqual({ kind: 'unavailable', code: 'action_account_scope_changed' });
});

import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountNoticeArtifactFixture, createServiceHealthNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createAccountNoticeInvestigation } from './accountNoticeInvestigation';

describe('private notice investigation through the Action front door', () => {
    it('recovers the receipt investigation after its admission owner remounts, without scanning Sessions', async () => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'env', deploymentId: 'receipt' } as const;
        const calls: Array<{ action: unknown; input: unknown }> = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: async request => {
            calls.push({ action: request.action, input: request.input });
            if (request.action.localId === 'sessions/run-configured-v1') return { ok: true,
                result: { v: 1, handoff: { kind: 'sendResult', session: { serverId: scope.serverId, sessionId: 'linked-investigation' },
                    result: { status: 'accepted', localId: 'investigate-input' } } } };
            // The contributed Action is the persistence boundary. Its durable
            // relationship survives destruction of every UI admission owner.
            const input = request.input as Readonly<{ entryRef: unknown }>;
            return { ok: true, result: { kind: 'complete', lanes: [], links: [
                { entryRef: input.entryRef, sessionId: 'linked-investigation', linkedAtMs: 10, displayPath: 'Failed deployment' },
            ] } };
        } }));
        const createOwner = () => createAccountNoticeInvestigation({ scope, isCurrent: () => true,
            execute: createFrontDoorActionExecute(executor) });
        const original = createOwner();
        await original.run(subject, { configuredActionId: 'investigate', sessionChoice: { kind: 'new' },
            agentChoice: { kind: 'configured' }, delivery: 'configured' });
        original.dispose();
        calls.length = 0;
        const reopened = createOwner();
        const session = await reopened.readLinkedSession(subject);
        expect(session).toEqual({ serverId: scope.serverId, sessionId: 'linked-investigation' });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.action).toEqual({ pluginId: 'happier.triage', localId: 'sessions/read-source-links-v1' });
        expect(calls[0]?.input).toMatchObject({ v: 1, entryRef: expect.any(Object) });
        reopened.dispose();
    });
    it('carries a failed receipt identity through the shared front door and refuses an expired Account scope', async () => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'env', deploymentId: 'receipt' } as const;
        const selection = { configuredActionId: 'investigate', sessionChoice: { kind: 'new' },
            agentChoice: { kind: 'configured' }, delivery: 'configured' } as const;
        const inputs: unknown[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: async request => {
            inputs.push(request.input);
            return { ok: true, result: { v: 1, handoff: { kind: 'selectionRequired', fields: ['placement'] } } };
        } }));
        let current = true;
        const owner = createAccountNoticeInvestigation({ scope, isCurrent: () => current, execute: createFrontDoorActionExecute(executor) });
        expect(owner.isEligible(subject)).toBe(true);
        await owner.run(subject, selection, { placement: { machine: { serverId: scope.serverId, machineId: 'chosen' } } });
        expect(inputs).toEqual([{ v: 1, handoff: { task: 'investigate', ...selection,
            context: { kind: 'failure', subject, machine: { serverId: scope.serverId, machineId: 'chosen' } },
            evidence: [{ kind: 'failure', subject }] } }]);
        current = false;
        expect(owner.isEligible(subject)).toBe(false);
        expect(await owner.run(subject, selection)).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(inputs).toHaveLength(1);
    });
    it('hands a persisted provider alertEntry to the same configured Action and refuses stale or unowned presses', async () => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const investigationOperand = { kind: 'alertEntry', entry: {
            entryRef: { source: { pluginId: 'acme.review', localId: 'issues' }, kindId: 'issue', collisionScope: 'project', entryId: '42' },
            sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        } } as const;
        const artifact = createAccountNoticeArtifactFixture({ header: {
            investigation: investigationOperand, body: 'Bounded provider evidence', healthPhase: 'open',
        } });
        const header = readAccountNoticeArtifactHeader(artifact, scope.accountId)!;
        const entry = { artifact, header };
        const selection = { configuredActionId: 'chosen-investigate', sessionChoice: { kind: 'configured' },
            agentChoice: { kind: 'configured' }, delivery: 'configured' } as const;
        const calls: Array<{ action: unknown; input: unknown }> = [];
        let current = true;
        // Only contributed Action invocation crosses the realm boundary.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: async request => {
            calls.push({ action: request.action, input: request.input });
            return { ok: true, result: request.action.localId === 'actions/read-v1'
                ? { v: 1, kind: 'choices', defaultActionId: null, actions: [{ label: 'Investigate', selection }] }
                : { v: 1, handoff: { kind: 'selectionRequired', fields: ['placement'] } } };
        } }));
        const investigation = createAccountNoticeInvestigation({ scope, isCurrent: () => current,
            execute: createFrontDoorActionExecute(executor) });
        expect(await investigation.readChoices(entry)).toMatchObject({ kind: 'choices' });
        expect(investigation.isEligible(entry)).toBe(true);
        expect(await investigation.run(entry, selection)).toMatchObject({ ok: true,
            result: { handoff: { kind: 'selectionRequired', fields: ['placement'] } } });
        expect(calls).toEqual([
            { action: { pluginId: 'happier.triage', localId: 'actions/read-v1' }, input: { v: 1, projection: 'sessionHandoff', task: 'investigate' } },
            { action: { pluginId: 'happier.triage', localId: 'sessions/run-configured-v1' }, input: { v: 1, handoff: {
                task: 'investigate', ...selection, context: { kind: 'entry', entry: investigationOperand.entry },
                evidence: [{ kind: 'alertEntry', entry: investigationOperand.entry }],
            } } },
        ]);
        const legacyArtifact = createAccountNoticeArtifactFixture();
        const legacyEntry = { artifact: legacyArtifact, header: readAccountNoticeArtifactHeader(legacyArtifact, scope.accountId)! };
        expect(investigation.isEligible(legacyEntry)).toBe(false);
        expect(await investigation.run(legacyEntry, selection)).toMatchObject({ ok: false });
        const unowned = { ...entry, artifact: { ...artifact, ownerAccountId: 'other-account' } };
        expect(await investigation.run(unowned, selection)).toMatchObject({ ok: false });
        current = false;
        expect(investigation.isEligible(entry)).toBe(false);
        expect(await investigation.run(entry, selection)).toMatchObject({ ok: false });
        expect(calls).toHaveLength(2);
    });
    it.each(['machine_service', 'environment', 'resource_limit'] as const)('admits %s evidence and retires stale presses', async page => {
        const scope = { serverId: 'srv-health-home', accountId: 'account-a' };
        const resource = { topic: 'resource_limit', kind: 'cpu_busy', phase: 'started', machineId: 'resource-machine',
            at: 2_000, since: 1_000, guardEnabled: false, evidence: { abovePct: 90, sustainMs: 1_000, busyPct: 99 } } as const;
        const artifact = page === 'machine_service' ? createServiceHealthNoticeArtifactFixture(scope.serverId)
            : page === 'resource_limit' ? createUsageNoticeArtifactFixture({
                header: { v: 1, kind: 'usage_notice.v1', title: 'Machine needs attention', status: 'open', notice: resource },
                body: JSON.stringify({ v: 1, notice: resource }),
            }) : createAccountNoticeArtifactFixture({ header: {
                title: 'Platform deployment needs attention', type: 'blocked', healthPhase: 'open',
                source: { kind: 'host', topic: 'service_health', subject: {
                    kind: 'platformTarget', environmentId: 'environment', targetLinkId: 'platform-link',
                } },
                page: { kind: 'host', page: 'environment', targetLinkId: 'platform-link',
                    environment: { serverId: scope.serverId, projectSourceId: 'project', environmentId: 'environment' } },
            } });
        const header = readAccountNoticeArtifactHeader(artifact, scope.accountId)!;
        const entry = { artifact, header };
        const selection = { configuredActionId: 'investigate', sessionChoice: { kind: 'configured' },
            agentChoice: { kind: 'configured' }, delivery: 'configured' } as const;
        const placement = page === 'environment' ? { machine: { serverId: scope.serverId, machineId: 'chosen-machine' } } : undefined;
        let current = true;
        const calls: Array<{ action: unknown; input: unknown }> = [];
        // Only the contributed plugin invocation crosses the process/realm boundary.
        // Notice admission, Action parsing and the front door remain real.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: async request => {
            calls.push({ action: request.action, input: request.input });
            return { ok: true, result: request.action.localId === 'actions/read-v1'
                ? { v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [{ label: 'Investigate', selection }] }
                : { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
        } }));
        const investigation = createAccountNoticeInvestigation({ scope, isCurrent: () => current,
            execute: createFrontDoorActionExecute(executor) });
        expect(await investigation.readChoices(entry)).toMatchObject({ kind: 'choices', defaultActionId: 'investigate' });
        expect(await investigation.run(entry, selection, placement ? { placement } : undefined)).toMatchObject({ ok: true,
            result: { handoff: { kind: 'composed' } } });
        expect(calls).toEqual([
            { action: { pluginId: 'happier.triage', localId: 'actions/read-v1' }, input: { v: 1, projection: 'sessionHandoff', task: 'investigate' } },
            { action: { pluginId: 'happier.triage', localId: 'sessions/run-configured-v1' }, input: { v: 1, handoff: {
                task: 'investigate', ...selection,
                context: { kind: 'healthAlert', notice: { kind: 'host', artifactId: artifact.id, source: header.source },
                    target: page === 'resource_limit' ? { kind: 'machine', machine: { serverId: scope.serverId, machineId: resource.machineId } }
                        : header.page, ...placement },
                evidence: [{ kind: 'alert', notice: { kind: 'host', artifactId: artifact.id, source: header.source } }],
            } } },
        ]);
        if (page !== 'resource_limit') {
            const foreignHome = createAccountNoticeInvestigation({ scope: { ...scope, serverId: 'other-home' },
                isCurrent: () => true, execute: createFrontDoorActionExecute(executor) });
            expect(await foreignHome.run(entry, selection)).toMatchObject({ ok: false });
            expect(calls).toHaveLength(2);
        }
        current = false;
        expect(await investigation.run(entry, selection)).toMatchObject({ ok: false });
        expect(calls).toHaveLength(2);
    });
});

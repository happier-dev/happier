import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployment-protocol';
import { projectDeploymentReceiptFactsV1, projectDeploymentReceiptHistoryEntryV1, selectDeploymentReceiptRetainedHistoryV1 } from './deploymentReceiptFacts';

describe('receipt facts', () => {
    it.each(['running', 'failed'] as const)('carries controller and %s member step timing through the parsed history read', async state => {
        const { DeploymentReceiptHistoryV1Schema } = await import('@happier-dev/deployment-protocol/v1');
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.steps = [{ id: 'prepare', label: 'Prepare', state: 'succeeded', startedAtMs: 100, settledAtMs: 200, durationMs: 100 }];
        receipt.content.machineResults = [{ machineId: 'machine-a', installationId: 'installation-a',
            steps: [{ id: 'activate', label: 'Activate', state, startedAtMs: 200 }],
            activation: 'pending', health: 'unknown' }];
        const facts = projectDeploymentReceiptHistoryEntryV1(receipt);
        const page = DeploymentReceiptHistoryV1Schema.parse({ ok: true, nextCursor: null,
            items: [{ ...receipt.deployment, steps: facts.steps }] });
        expect(page.items[0]?.steps).toEqual([
            { id: 'prepare', label: 'Prepare', state: 'succeeded', startedAtMs: 100, settledAtMs: 200, durationMs: 100 },
            { id: 'activate', label: 'Activate', state, startedAtMs: 200, machineId: 'machine-a' },
        ]);
    });
    it('projects historical Machines from opened receipt content without consulting current placement', () => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.machines = ['former-runtime'];
        receipt.content.buildMachineId = 'former-builder';
        receipt.deployment.acceptedExecution = { v: 1,
            controller: { machineId: 'former-controller', installationId: 'install-controller' } };
        expect(projectDeploymentReceiptHistoryEntryV1(receipt).machineIds)
            .toEqual(['former-runtime', 'former-builder', 'former-controller']);
    });
    it.each([
        { phase: 'restore', restoration: 'succeeded', health: 'unverified', expected: { kind: 'failed' } },
        { phase: 'activate', restoration: 'succeeded', health: 'unhealthy', expected: { kind: 'failed' } },
        { phase: 'activate', restoration: 'failed', health: 'unknown', expected: { kind: 'failed' } },
        { phase: 'activate', restoration: 'outcome_unknown', health: 'unknown', expected: { kind: 'outcome_unknown' } },
        { phase: 'activate', restoration: 'succeeded', health: 'unknown', expected: { kind: 'outcome_unknown' } },
        { phase: 'activate', restoration: 'succeeded', health: 'unverified', expected: { kind: 'succeeded', health: 'unverified' } },
        { phase: 'activate', restoration: 'succeeded', health: 'healthy', expected: { kind: 'succeeded', health: 'healthy' } },
    ] as const)('projects one restoration consequence from phase=$phase, restoration=$restoration and health=$health', ({ phase, restoration, health, expected }) => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.failure = { code: 'deployment_failed', phase };
        receipt.content.machineResults = receipt.content.machines.map(machineId => ({ machineId, installationId: 'installation-a',
            steps: [], activation: 'failed', restoration, health }));
        expect(projectDeploymentReceiptFactsV1(receipt).restoration).toEqual(expected);
        receipt.content.machineResults = [...receipt.content.machineResults,
            { machineId: 'second-machine', installationId: 'installation-b', steps: [], activation: 'failed', health: 'unknown' }];
        receipt.content.machines = [...receipt.content.machines, 'second-machine'];
        if (expected.kind === 'succeeded') expect(projectDeploymentReceiptFactsV1(receipt).restoration).toEqual({ kind: 'outcome_unknown' });
    });

    it('offers the existing log viewer a platform receipt reference without native stage files', () => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.ownServer = undefined;
        receipt.content.platform = { targetLinkRevision: 1,
            credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'acme.alpha', localId: 'inspect' }, purpose: 'deploy' },
                target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
            providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' }, observation: { v: 1, state: 'succeeded', observedAtMs: 1,
                providerDeploymentId: 'dpl_exact' } };
        receipt.deployment.acceptedExecution = undefined;
        expect(projectDeploymentReceiptFactsV1(receipt).logs).toEqual([{ scope: 'operation', excerpt: null, reference: {
            kind: 'build', environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id,
            targetLinkId: receipt.deployment.targetLinkId } }]);
    });

    it('says where a receipt ran from its target kind: a platform keeps its own releases, so no Machine keep count (COR4B ui-60)', () => {
        const machine = createDeploymentReceiptDetailV1();
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'serving' });
        const retainedHistory = { receipt: machine.deployment, items: [{ ...machine.deployment, source: projectDeploymentReceiptFactsV1(machine).source }],
            complete: true, runtime, targetLinks: [runtime], retainPreviousDeployments: 0 };
        expect(projectDeploymentReceiptFactsV1(machine, retainedHistory)).toMatchObject({ placement: 'machine', retainedPreviousCount: 0 });
        const platform = createDeploymentReceiptDetailV1();
        platform.content.ownServer = undefined;
        platform.content.platform = { targetLinkRevision: 1,
            credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'acme.alpha', localId: 'inspect' }, purpose: 'deploy' },
                target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
            providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' }, observation: { v: 1, state: 'succeeded', observedAtMs: 1, providerDeploymentId: 'dpl_exact' } };
        // The same history and retention setting: a platform release is not "kept on a Machine", so nothing reads "Off".
        expect(projectDeploymentReceiptFactsV1(platform, { ...retainedHistory, receipt: platform.deployment }))
            .toMatchObject({ placement: 'platform', retainedPreviousCount: null });
    });

    it('joins previous, retained count and rollback to the same history instead of captured admission and configured capacity', () => {
        const base = createDeploymentReceiptDetailV1();
        if (base.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
        const sourceIntent = { ...base.content.sourceIntent, sha: 'b'.repeat(40) };
        const current = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
            id: 'current', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002,
        }), content: { ...base.content, sourceIntent, ownServer: { rollbackTarget: null, approvedInputBasis: {
            v: 1, environmentId: base.deployment.environmentId, environmentRevision: 1,
            targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true },
        } } } });
        const previous = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'previous' }) });
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: current.deployment.id });
        const row = (receipt: typeof current) => ({ ...receipt.deployment, source: projectDeploymentReceiptFactsV1(receipt).source });
        const retainedHistory = { receipt: current.deployment, items: [row(current), row(previous)], complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1 };
        expect(projectDeploymentReceiptFactsV1(current, retainedHistory)).toMatchObject({
            rollbackTarget: null,
            previousVersion: { deploymentId: 'previous', revision: { kind: 'repository', sha: 'a'.repeat(40) } },
            retainedPreviousCount: 1,
            retainedRollbackTarget: { deploymentId: 'previous', revision: { kind: 'repository', sha: 'a'.repeat(40) } },
        });
        // A second receipt of the already-serving commit must not offer a rollback to that commit.
        const sameVersion = createDeploymentReceiptDetailV1({ deployment: previous.deployment, content: current.content });
        expect(projectDeploymentReceiptFactsV1(sameVersion, { ...retainedHistory, receipt: sameVersion.deployment,
            items: [row(current), row(sameVersion)] }))
            .toMatchObject({ retainedRollbackTarget: null });
        // A retention setting of one with no retained predecessor is still a first deployment.
        expect(projectDeploymentReceiptFactsV1(current, { ...retainedHistory, items: [row(current)] }))
            .toMatchObject({ previousVersion: null, retainedPreviousCount: 0, retainedRollbackTarget: null });
    });
    it('selects retained successful predecessors in order, excluding failed attempts, other links and the serving receipt', () => {
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'current' });
        const current = createDeploymentReceiptHeaderV1({ id: 'current', requestedAtMs: 2000,
            startedAtMs: 2001, settledAtMs: 2002 });
        const previous = createDeploymentReceiptHeaderV1({ id: 'previous' });
        const previousVersion = { deploymentId: previous.id, revision: { kind: 'repository' as const, sha: 'a'.repeat(40) } };
        const items = [{ ...current, source: { kind: 'repository' as const, sha: 'b'.repeat(40) } },
            createDeploymentReceiptHeaderV1({ id: 'failed', state: 'failed' }),
            createDeploymentReceiptHeaderV1({ id: 'other-link', targetLinkId: 'unrelated' }), { ...previous, source: previousVersion.revision }];
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items, complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1 }))
            .toEqual({ previousVersion, retainedPreviousCount: 1, retainedRollbackTarget: previousVersion });
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items: [current], complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1 }))
            .toEqual({ previousVersion: null, retainedPreviousCount: 0, retainedRollbackTarget: null });
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items: [current], complete: false,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1 }))
            .toEqual({ previousVersion: undefined, retainedPreviousCount: null, retainedRollbackTarget: null });
    });
    it('names a history attempt by its revision and carries its recorded failure as a fact, never a title word', () => {
        const base = createDeploymentReceiptDetailV1();
        const failure = { code: 'native_activate_failed', phase: 'activate' } as const;
        const failed = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
            content: { ...base.content, failure } });
        expect(projectDeploymentReceiptHistoryEntryV1(failed)).toMatchObject({ historyTitle: 'aaaaaaa', failure });
        expect(projectDeploymentReceiptHistoryEntryV1(base)).toMatchObject({ historyTitle: 'aaaaaaa', failure: null });
    });
    it('keeps data teardown outcome evidence without inventing an app source revision', () => {
        const receipt = createDeploymentReceiptDetailV1();
        const content = DeploymentDataTeardownContentV1Schema.parse({ machines: [], images: [], machineResults: [],
            steps: [{ id: 'delete', label: 'Delete branch', state: 'failed' }],
            platform: { credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'acme.alpha', localId: 'branch' }, purpose: 'account' },
                target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
                providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'branch:A' },
                providerEnvironment: { kind: 'custom', id: 'A' }, targetLinkRevision: 1,
                observation: { v: 1, state: 'failed', observedAtMs: 1000 },
                dataCreation: { reference: { runId: 'run:one', invocationId: 'inv:one' }, retainedProviderResource: true,
                    deleteAction: { pluginId: 'acme.alpha', localId: 'delete' }, operands: { branchId: 'A' } } } });
        expect(projectDeploymentReceiptFactsV1({ ...receipt, content })).toMatchObject({ source: null,
            steps: [{ id: 'delete', state: 'failed' }] });
    });
});

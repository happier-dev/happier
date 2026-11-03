import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployment-protocol';
import { projectDeploymentReceiptFactsV1, projectDeploymentReceiptHistoryEntryV1, selectDeploymentReceiptRetainedHistoryV1 } from './deploymentReceiptFacts';

describe('receipt facts', () => {
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
    it('names a failed history attempt by its revision and recorded reason instead of the Environment title', () => {
        const base = createDeploymentReceiptDetailV1();
        const failed = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
            content: { ...base.content, failure: { code: 'native_activate_failed', phase: 'activate' } } });
        expect(projectDeploymentReceiptHistoryEntryV1(failed)).toMatchObject({ historyTitle: 'aaaaaaa · native_activate_failed' });
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

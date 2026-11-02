import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployment-protocol';
import { projectDeploymentReceiptFactsV1 } from './deploymentReceiptFacts';

describe('receipt facts', () => {
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

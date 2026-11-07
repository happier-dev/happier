import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployment-protocol';
import { deploymentDeployAvailability, deploymentSourceLabel, deploymentHeadline, deploymentStateLabel, deploymentHistoryLead, deploymentStateNotice, deploymentRailState } from './deploymentPresentation';

it('presents the recorded interruption reason on the receipt and its history row', () => {
    const receipt = createDeploymentReceiptHeaderV1({ state: 'outcome_unknown' });
    const failure = { code: 'deployment_activation_not_observed', phase: 'observe' as const };
    const notice = deploymentStateNotice(receipt.state, failure);
    expect(notice?.text).not.toBe(deploymentStateNotice(receipt.state)?.text);
    expect(deploymentHistoryLead(receipt, failure)).toEqual(notice);
    expect(deploymentHistoryLead(receipt, null)?.text).toBe(deploymentStateLabel('outcome_unknown'));
});

describe('deploy availability', () => {
    const environment = { capabilities: { deploy: true } } as Parameters<typeof deploymentDeployAvailability>[0]['environment'];
    const link = (targetKind: string) => ({ id: 'link-1', targetKind }) as NonNullable<Parameters<typeof deploymentDeployAvailability>[0]['runtimeTargetLink']>;

    it.each(['ownServer', 'vercel', 'cloudflare-pages'])('any linked %s target is ready with its link id; its daemon target decides the rest', (targetKind) => {
        expect(deploymentDeployAvailability({ environment, runtimeTargetLink: link(targetKind) }))
            .toEqual({ kind: 'ready', targetLinkId: 'link-1' });
    });

    it('needs a link and the permission', () => {
        expect(deploymentDeployAvailability({ environment, runtimeTargetLink: null })).toEqual({ kind: 'noTarget' });
        expect(deploymentDeployAvailability({
            environment: { capabilities: { deploy: false } } as typeof environment, runtimeTargetLink: link('vercel'),
        })).toEqual({ kind: 'denied' });
    });
});

describe('data cleanup receipt presentation', () => {
    it('uses the recorded outcome when cleanup has no application source', () => {
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
        const receipt = createDeploymentReceiptHeaderV1({ operation: 'teardown', state: 'failed' });
        expect(deploymentSourceLabel(content)).toBeNull();
        expect(deploymentHeadline(receipt, content)).toBe(deploymentStateLabel('failed'));
    });
});

it('marks a version running without a health check amber in the rail, like an unknown outcome', () => {
    expect(deploymentRailState('running_unverified')?.tone).toBe('warning');
    expect(deploymentRailState('running')?.tone).toBeNull();
});

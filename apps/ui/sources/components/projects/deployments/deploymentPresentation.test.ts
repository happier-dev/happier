import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentReceiptMetadataV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { deploymentDeployAvailability, deploymentFailureTitle, deploymentSourceLabel, deploymentHeadline, deploymentStateLabel, deploymentHistoryLead, deploymentStateNotice, deploymentRailState, deploymentEnvironmentAttention, deploymentAttentionLeaves } from './deploymentPresentation';

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

describe('receipt titles name the operation the receipt records', () => {
    // The protocol's own operation vocabulary, so a new operation fails here until it has its words.
    const operations = DeploymentReceiptMetadataV1Schema.shape.operation.options;
    const { content } = createDeploymentReceiptDetailV1();
    const headline = (operation: (typeof operations)[number], state: 'running' | 'succeeded' | 'failed' | 'cancelled') =>
        deploymentHeadline(createDeploymentReceiptHeaderV1({ operation, state }), content);

    it.each(['running', 'succeeded', 'failed', 'cancelled'] as const)('%s: every operation reads differently', (state) => {
        const titles = operations.map(operation => headline(operation, state));
        expect(new Set(titles).size).toBe(operations.length);
    });

    it.each([undefined, 'admission'] as const)('failed (%s): every operation names its own failure', (phase) => {
        const titles = operations.map(operation => deploymentFailureTitle(phase ? { code: 'failed', phase } : null, operation));
        expect(new Set(titles).size).toBe(operations.length);
    });

    it('a succeeded teardown never reads as deployed', () => {
        expect(headline('teardown', 'succeeded')).not.toBe(headline('deploy', 'succeeded'));
        const failure = { code: 'failed', phase: 'teardown' as const };
        expect(deploymentHistoryLead(createDeploymentReceiptHeaderV1({ operation: 'teardown', state: 'failed' }), failure)?.text)
            .toBe(deploymentFailureTitle(failure, 'teardown'));
    });
});

describe('Environment attention slot (DEPLOY-COMPOSE R3): one notice, highest precedence first', () => {
    const calm = {
        machineOffline: false, noTarget: false, controller: null, refused: false, reviewPending: false,
        latest: null, health: null, servingState: null,
    } satisfies Parameters<typeof deploymentEnvironmentAttention>[0];
    const failed = { id: 'd-failed', state: 'failed' as const };

    it('a healthy, settled Environment says nothing', () => {
        expect(deploymentEnvironmentAttention(calm)).toBeNull();
        expect(deploymentEnvironmentAttention({ ...calm, latest: { id: 'd-1', state: 'succeeded' }, health: { status: 'up' },
            servingState: 'succeeded', controller: { state: 'available' } })).toBeNull();
    });

    it('when everything is wrong at once, only the blocking notice shows, then each lower one as the higher clears', () => {
        const all = { ...calm, machineOffline: true, noTarget: true, controller: { state: 'paused' as const }, refused: true,
            latest: failed, reviewPending: true, health: { status: 'down' as const }, servingState: 'running_unverified' as const };
        const shown: string[] = [];
        let facts: Parameters<typeof deploymentEnvironmentAttention>[0] = all;
        const clear = {
            machineOffline: { machineOffline: false }, noTarget: { noTarget: false }, controllerPaused: { controller: null },
            actionRefused: { refused: false }, latestFailed: { latest: null }, approvalWaiting: { reviewPending: false },
            unhealthy: { health: null }, runningUnverified: { servingState: null },
        } as const;
        for (;;) {
            const attention = deploymentEnvironmentAttention(facts);
            if (!attention) break;
            shown.push(attention.kind);
            facts = { ...facts, ...clear[attention.kind as keyof typeof clear] };
        }
        expect(shown).toEqual(['machineOffline', 'noTarget', 'controllerPaused', 'actionRefused', 'latestFailed',
            'approvalWaiting', 'unhealthy', 'runningUnverified']);
    });

    it('names the receipt it is about: a failed latest deploy, or the one still deploying', () => {
        expect(deploymentEnvironmentAttention({ ...calm, latest: failed })).toEqual({ kind: 'latestFailed', deploymentId: 'd-failed' });
        expect(deploymentEnvironmentAttention({ ...calm, latest: { id: 'd-run', state: 'queued' }, health: { status: 'down' } }))
            .toEqual({ kind: 'deploying', deploymentId: 'd-run' });
    });

    it('a newer catalog release is the quietest notice: it shows only when nothing else does', () => {
        expect(deploymentEnvironmentAttention({ ...calm, catalogUpdate: true })).toEqual({ kind: 'catalogUpdate' });
        expect(deploymentEnvironmentAttention({ ...calm, catalogUpdate: true, servingState: 'running_unverified' })?.kind).toBe('runningUnverified');
    });

    it('an unknown controller makes no claim; a degraded service needs the person', () => {
        expect(deploymentEnvironmentAttention({ ...calm, controller: { state: 'unknown' } })).toBeNull();
        expect(deploymentEnvironmentAttention({ ...calm, health: { status: 'degraded' } })?.kind).toBe('unhealthy');
    });

    it('row-level notices below the shown one stay visible in their rows; higher ones hide them', () => {
        expect(deploymentAttentionLeaves(null, 'secretWithdrawn')).toBe(true);
        expect(deploymentAttentionLeaves({ kind: 'runningUnverified' }, 'secretWithdrawn')).toBe(true);
        expect(deploymentAttentionLeaves({ kind: 'unhealthy' }, 'secretWithdrawn')).toBe(false);
    });
});

describe('an unconfirmed receipt names its recorded cause', () => {
    it('says the recovery owner remedy for a typed cause, and keeps the check-the-Machine body without one', async () => {
        const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
        const caused = { code: 'outcome_unknown', phase: 'activate' as const, failureCause: {
            phase: 'deployment.transition', errorClass: 'HttpStatusError' as const, errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503 } };
        expect(deploymentStateNotice('outcome_unknown', caused)?.text)
            .toBe(readDeploymentRefusalRecoveryV1('database_transaction_conflict_exhausted')?.remedy);
        expect(deploymentStateNotice('outcome_unknown', { code: 'outcome_unknown', phase: 'activate' })?.text)
            .toBe(deploymentStateNotice('outcome_unknown')?.text);
    });
});

describe('deploy and Action actor labels (lab envOv/fAct; owner ruling 05:14Z: actor, never requestedByAccountId)', () => {
    const viewer = 'account-viewer';
    const none = { actorKind: null, displayName: null, onBehalfOf: null } as const;

    it('says You for the viewer, a person by name, and nothing for an unknown historical actor', async () => {
        const { deploymentActorLabel } = await import('./deploymentPresentation');
        expect(deploymentActorLabel({ actorKind: 'person', displayName: 'Viewer Name', onBehalfOf: null },
            { actorKind: 'person', accountId: viewer }, viewer)).toBe('You');
        expect(deploymentActorLabel({ actorKind: 'person', displayName: 'Ana Ruiz', onBehalfOf: null },
            { actorKind: 'person', accountId: 'account-ana' }, viewer)).toBe('Ana Ruiz');
        // A person whose name is still reading says nothing yet rather than a placeholder that flips.
        expect(deploymentActorLabel({ actorKind: 'person', displayName: null, onBehalfOf: null },
            { actorKind: 'person', accountId: 'account-ana' }, viewer)).toBeNull();
        expect(deploymentActorLabel(none, null, viewer)).toBeNull();
        expect(deploymentActorLabel(none, undefined, viewer)).toBeNull();
    });

    it('names an agent with whose session it is, and a workflow by its name', async () => {
        const { deploymentActorLabel } = await import('./deploymentPresentation');
        const onBehalfOf = (accountId: string, displayName: string) => ({ serverId: 'server-a', accountId, displayName });
        expect(deploymentActorLabel({ actorKind: 'agent', displayName: 'Claude', onBehalfOf: onBehalfOf('account-ana', 'Ana') },
            { actorKind: 'agent', sessionId: 'session-1', onBehalfOf: { serverId: 'server-a', accountId: 'account-ana' } }, viewer))
            .toBe('Claude (Ana’s session)');
        expect(deploymentActorLabel({ actorKind: 'agent', displayName: 'Claude', onBehalfOf: onBehalfOf(viewer, 'Viewer Name') },
            { actorKind: 'agent', sessionId: 'session-1', onBehalfOf: { serverId: 'server-a', accountId: viewer } }, viewer))
            .toBe('Claude (your session)');
        expect(deploymentActorLabel({ actorKind: 'agent', displayName: null, onBehalfOf: null },
            { actorKind: 'agent', sessionId: 'session-1' }, viewer)).toBe('An agent');
        expect(deploymentActorLabel({ actorKind: 'workflow', displayName: 'Nightly backups', onBehalfOf: null },
            { actorKind: 'workflow', runId: 'run-1' }, viewer)).toBe('Nightly backups');
        expect(deploymentActorLabel({ actorKind: 'workflow', displayName: null, onBehalfOf: null },
            { actorKind: 'workflow', runId: 'run-1' }, viewer)).toBe('A workflow');
    });
});

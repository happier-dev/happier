import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentReceiptMetadataV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { projectDeploymentReceiptSourceFactsV1 } from '@happier-dev/deployments';
import { deploymentReceiptTitleV1 } from '@happier-dev/deployment-protocol/v1';
import { t } from '@/text';
import { deploymentDeployAvailability, deploymentFailureTitle, deploymentReceiptTitle, deploymentRevisionLabel, deploymentStateLabel, deploymentHistoryLead, deploymentStateNotice, deploymentRailState, deploymentEnvironmentAttention, DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER, deploymentAttentionLeaves, deploymentEnvironmentRowState, deploymentHealthFact, deploymentSettledStateLabel } from './deploymentPresentation';

it('presents the recorded interruption reason on the receipt and its history row', () => {
    const receipt = createDeploymentReceiptHeaderV1({ state: 'outcome_unknown' });
    const failure = { code: 'deployment_activation_not_observed', phase: 'observe' as const };
    const notice = deploymentStateNotice(receipt.state, failure);
    expect(notice?.text).not.toBe(deploymentStateNotice(receipt.state)?.text);
    expect(deploymentHistoryLead(receipt, failure)).toEqual(notice);
    expect(deploymentHistoryLead(receipt, null)).toEqual({
        tone: 'warning', text: t('projects.deployments.stateUnknownShort'),
    });
});

it('leads a failed history row with the recorded container cause and recovery', () => {
    const receipt = createDeploymentReceiptHeaderV1({ state: 'failed' });
    const failure = { code: 'native_failed', phase: 'activate' as const,
        nativeActivation: { service: 'web', exitStatus: 78, missingVariable: 'FIELD_NOTES_SECRET_KEY' } };
    expect(deploymentHistoryLead(receipt, failure)).toEqual({
        tone: 'danger', text: expect.stringMatching(/web.*78.*FIELD_NOTES_SECRET_KEY.*Variables/),
    });
});

it('shows the Machine carrier recovery when a fleet archive restore fails', async () => {
    const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
    const receipt = createDeploymentReceiptHeaderV1({ state: 'failed' });
    const failure = {
        code: 'machine_carrier_unavailable',
        phase: 'restore' as const,
        failureCause: {
            errorClass: 'Error' as const,
            httpStatus: null,
            phase: 'daemon.filesystem.copy.source.iroh.tunnel_open',
            errorCode: 'machine_carrier_unavailable',
            nativeErrorCode: 'transport-unavailable',
        },
    };
    expect(deploymentHistoryLead(receipt, failure)).toEqual({
        tone: 'danger',
        text: readDeploymentRefusalRecoveryV1('machine_carrier_unavailable')?.remedy,
    });
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
                providerEnvironment: { kind: 'native', selection: { branchId: 'A' } }, targetLinkRevision: 1,
                observation: { v: 1, state: 'failed', observedAtMs: 1000 },
                dataCreation: { reference: { runId: 'run:one', invocationId: 'inv:one' }, retainedProviderResource: true,
                    deleteAction: { pluginId: 'acme.alpha', localId: 'delete' }, operands: { branchId: 'A' } } } });
        const receipt = createDeploymentReceiptHeaderV1({ operation: 'teardown', state: 'failed' });
        const { source } = projectDeploymentReceiptSourceFactsV1(content);
        expect(source).toBeNull();
        // No application source: the title still names the failed removal, never a bare state word.
        expect(deploymentReceiptTitle(receipt, null)).toBe(t('projects.deployments.receipt.titleRemoveFailed'));
    });
});

it('R15-D1: a version running without a health check is quiet in every list and history row; the Overview says it once', () => {
    expect(deploymentRailState('running_unverified')).toBeNull();
    expect(deploymentRailState('running')?.tone).toBeNull();
    expect(deploymentHistoryLead(createDeploymentReceiptHeaderV1({ state: 'running_unverified' }), null)).toBeNull();
    expect(deploymentEnvironmentRowState({ currentDeployment: { state: 'running_unverified' } })).toBeNull();
    // A list's quiet State word says it was deployed, never "Running, not verified" beside an Overview that says Passing.
    expect(deploymentSettledStateLabel('running_unverified')).toBe(deploymentStateLabel('succeeded'));
    expect(deploymentRailState('outcome_unknown')?.tone).toBe('warning');
});

describe('receipt titles name the operation the receipt records', () => {
    // The protocol's own operation vocabulary, so a new operation fails here until it has its words.
    const operations = DeploymentReceiptMetadataV1Schema.shape.operation.options;
    const { content } = createDeploymentReceiptDetailV1();
    const { source } = projectDeploymentReceiptSourceFactsV1(content);
    const label = source ? deploymentRevisionLabel(source) : null;
    const headline = (operation: (typeof operations)[number], state: 'running' | 'succeeded' | 'failed' | 'cancelled') =>
        deploymentReceiptTitle(createDeploymentReceiptHeaderV1({ operation, state }), label);

    it.each(['running', 'succeeded', 'failed', 'cancelled'] as const)('%s: every operation reads differently', (state) => {
        const titles = operations.map(operation => headline(operation, state));
        expect(new Set(titles).size).toBe(operations.length);
    });

    // A provider removal has no version of its own: its title still says it removed, never "Deployed".
    it.each(['running', 'succeeded', 'failed', 'cancelled'] as const)('%s: a removal with no version never reads as a deploy', (state) => {
        const title = (operation: 'deploy' | 'teardown') => deploymentReceiptTitle(createDeploymentReceiptHeaderV1({ operation, state }), null);
        expect(title('teardown')).not.toBe(title('deploy'));
        expect(deploymentReceiptTitleV1(createDeploymentReceiptHeaderV1({ operation: 'teardown', state }), null)).toBe(title('teardown'));
    });

    it.each(operations)('gives %s evidence the same title as the failed Receipt', (operation) => {
        const receipt = createDeploymentReceiptHeaderV1({ operation, state: 'failed' });
        expect(deploymentReceiptTitleV1(receipt, label)).toBe(deploymentReceiptTitle(receipt, label));
        expect(deploymentReceiptTitleV1(receipt, null)).toBe(deploymentReceiptTitle(receipt, null));
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
        latest: null, health: null,
    } satisfies Parameters<typeof deploymentEnvironmentAttention>[0];
    const failed = { id: 'd-failed', state: 'failed' as const };

    it('a healthy, settled Environment says nothing', () => {
        expect(deploymentEnvironmentAttention(calm)).toBeNull();
        expect(deploymentEnvironmentAttention({ ...calm, latest: { id: 'd-1', state: 'succeeded' }, health: { status: 'up' },
            controller: { state: 'available' } })).toBeNull();
    });

    it('when everything is wrong at once, only the blocking notice shows, then each lower one as the higher clears', () => {
        const all = { ...calm, machineOffline: true, noTarget: true, controller: { state: 'paused' as const }, refused: true,
            latest: failed, reviewPending: true, health: { status: 'down' as const } };
        const shown: string[] = [];
        let facts: Parameters<typeof deploymentEnvironmentAttention>[0] = all;
        const clear = {
            machineOffline: { machineOffline: false }, noTarget: { noTarget: false }, controllerPaused: { controller: null },
            actionRefused: { refused: false }, latestFailed: { latest: null }, approvalWaiting: { reviewPending: false },
            unhealthy: { health: null },
        } as const;
        for (;;) {
            const attention = deploymentEnvironmentAttention(facts);
            if (!attention) break;
            shown.push(attention.kind);
            facts = { ...facts, ...clear[attention.kind as keyof typeof clear] };
        }
        expect(shown).toEqual(['machineOffline', 'noTarget', 'controllerPaused', 'actionRefused', 'latestFailed',
            'approvalWaiting', 'unhealthy']);
    });

    it('owner 11-28: the maintenance page is said on every tab, above the 503s it causes, below anything that blocks', () => {
        expect(deploymentEnvironmentAttention({ ...calm, maintenance: true, latest: { id: 'd-1', state: 'succeeded' },
            health: { status: 'down' } })).toEqual({ kind: 'maintenance' });
        expect(deploymentEnvironmentAttention({ ...calm, maintenance: true, latest: failed })?.kind).toBe('latestFailed');
        expect(deploymentEnvironmentAttention({ ...calm, maintenance: true, machineOffline: true })?.kind).toBe('machineOffline');
    });

    it('names the receipt it is about: a failed latest deploy, or the one still deploying', () => {
        expect(deploymentEnvironmentAttention({ ...calm, latest: failed })).toEqual({ kind: 'latestFailed', deploymentId: 'd-failed' });
        expect(deploymentEnvironmentAttention({ ...calm, latest: { id: 'd-run', state: 'queued' }, health: { status: 'down' } }))
            .toEqual({ kind: 'deploying', deploymentId: 'd-run' });
    });

    it('R18-D2: a latest deploy whose outcome is unknown speaks on the Overview, as the rail does, and names its receipt', () => {
        expect(deploymentEnvironmentAttention({ ...calm, latest: { id: 'd-unknown', state: 'outcome_unknown' }, health: { status: 'up' } }))
            .toEqual({ kind: 'latestUnknown', deploymentId: 'd-unknown' });
        // A failure still outranks it; a deploy at work is said as such.
        expect(DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER.indexOf('latestFailed'))
            .toBeLessThan(DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER.indexOf('latestUnknown'));
    });

    it('R15-D6: a press that ran and left a failed receipt is that failure, said the same way before and after a reload', () => {
        expect(deploymentEnvironmentAttention({ ...calm, refused: true, refusedDeploymentId: 'd-failed', latest: failed }))
            .toEqual({ kind: 'latestFailed', deploymentId: 'd-failed' });
        // A refusal with no receipt of its own (or about another one) still speaks as the press's refusal.
        expect(deploymentEnvironmentAttention({ ...calm, refused: true, latest: failed })?.kind).toBe('actionRefused');
        expect(deploymentEnvironmentAttention({ ...calm, refused: true, refusedDeploymentId: 'd-other', latest: failed })?.kind)
            .toBe('actionRefused');
    });

    it('a newer catalog release is the quietest notice: it shows only when nothing else does', () => {
        expect(deploymentEnvironmentAttention({ ...calm, catalogUpdate: true })).toEqual({ kind: 'catalogUpdate' });
        const unchecked = { status: 'unknown' as const, members: [{ machineId: 'machine', roles: ['runtime' as const],
            status: 'unknown' as const, evidence: [{ role: 'runtime' as const, source: 'native' as const,
                status: 'unknown' as const, reason: 'running_unverified' }] }] };
        expect(deploymentEnvironmentAttention({ ...calm, catalogUpdate: true, health: unchecked })?.kind).toBe('runningUnverified');
    });

    it('keeps a serving receipt quiet until health settles, including during replacement', () => {
        expect(deploymentEnvironmentAttention(calm)).toBeNull();
        expect(deploymentHealthFact(undefined)).toEqual({ value: '—' });
        expect(deploymentHealthFact({ status: 'unknown' }))
            .toEqual({ value: '—' });
        expect(deploymentHealthFact(undefined, 'running')).toEqual({ value: '—' });
        expect(deploymentHealthFact(undefined, 'queued')).toEqual({ value: '—' });
        const checked = { status: 'degraded' as const, n: 2, down: 0, degraded: 0,
            failingSavedChecks: [{ sourceInstanceId: 'staging-http', automationId: 'automation', triggerId: 'trigger', checkId: 'endpoint', name: 'Status endpoint', status: 'down' as const }] };
        expect(deploymentHealthFact(checked, 'queued')).toEqual({
            value: t('projects.deployments.healthDegraded'), tone: 'attention',
        });
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

import type { DeploymentReceiptHeaderV1 } from '@happier-dev/plugin-sdk/protocol';

type ReceiptState = DeploymentReceiptHeaderV1['state'];
type ReceiptOperation = DeploymentReceiptHeaderV1['operation'];
type SettledState = Exclude<ReceiptState, 'running_unverified'>;
type OperationState = Exclude<SettledState, 'queued' | 'outcome_unknown' | 'skipped'>;
type TitleParams = { sha: string };

const OPERATION_HEADLINES = {
    deploy: {
        running: 'projects.deployments.headlineDeploying',
        succeeded: 'projects.deployments.headlineDeployed',
        failed: 'projects.deployments.headlineFailed',
        cancelled: 'projects.deployments.headlineCancelled',
    },
    rollback: {
        running: 'projects.deployments.headlineRollingBack',
        succeeded: 'projects.deployments.headlineRolledBack',
        failed: 'projects.deployments.headlineRollbackFailed',
        cancelled: 'projects.deployments.receipt.headlineRollbackCancelled',
    },
    promote: {
        running: 'projects.deployments.receipt.headlinePromoting',
        succeeded: 'projects.deployments.receipt.headlinePromoted',
        failed: 'projects.deployments.receipt.headlinePromoteFailed',
        cancelled: 'projects.deployments.receipt.headlinePromoteCancelled',
    },
    teardown: {
        running: 'projects.deployments.receipt.headlineRemoving',
        succeeded: 'projects.deployments.receipt.headlineRemoved',
        failed: 'projects.deployments.receipt.headlineRemoveFailed',
        cancelled: 'projects.deployments.receipt.headlineRemoveCancelled',
    },
} as const satisfies Record<ReceiptOperation, Record<OperationState, string>>;

/** A removal with no version of its own (a provider resource) still says it removed, never the deploy word. */
const UNVERSIONED_TEARDOWN_HEADLINES = {
    running: 'projects.deployments.receipt.titleRemoving',
    succeeded: 'projects.deployments.receipt.titleRemoved',
    failed: 'projects.deployments.receipt.titleRemoveFailed',
    cancelled: 'projects.deployments.receipt.titleRemoveCancelled',
} as const satisfies Record<OperationState, string>;

type HeadlineKey = (typeof OPERATION_HEADLINES)[ReceiptOperation][OperationState]
    | (typeof UNVERSIONED_TEARDOWN_HEADLINES)[OperationState]
    | 'projects.deployments.headlineQueued' | 'projects.deployments.headlineUnknown'
    | 'projects.deployments.headlineSkipped';

/** The host's English locale and headless clients use the same Receipt copy. */
export const DEPLOYMENT_RECEIPT_HEADLINE_COPY_EN = {
    'projects.deployments.headlineDeploying': ({ sha }) => `Deploying ${sha}`,
    'projects.deployments.headlineDeployed': ({ sha }) => `Deployed ${sha}`,
    'projects.deployments.headlineFailed': ({ sha }) => `Deploy of ${sha} failed`,
    'projects.deployments.headlineCancelled': ({ sha }) => `Deploy of ${sha} cancelled`,
    'projects.deployments.headlineRollingBack': ({ sha }) => `Rolling back to ${sha}`,
    'projects.deployments.headlineRolledBack': ({ sha }) => `Rolled back to ${sha}`,
    'projects.deployments.headlineRollbackFailed': ({ sha }) => `Rollback to ${sha} failed`,
    'projects.deployments.receipt.headlineRollbackCancelled': ({ sha }) => `Rollback to ${sha} cancelled`,
    'projects.deployments.receipt.headlinePromoting': ({ sha }) => `Promoting ${sha}`,
    'projects.deployments.receipt.headlinePromoted': ({ sha }) => `Promoted ${sha}`,
    'projects.deployments.receipt.headlinePromoteFailed': ({ sha }) => `Promotion of ${sha} failed`,
    'projects.deployments.receipt.headlinePromoteCancelled': ({ sha }) => `Promotion of ${sha} cancelled`,
    'projects.deployments.receipt.headlineRemoving': ({ sha }) => `Removing ${sha}`,
    'projects.deployments.receipt.headlineRemoved': ({ sha }) => `Removed ${sha}`,
    'projects.deployments.receipt.headlineRemoveFailed': ({ sha }) => `Couldn’t remove ${sha}`,
    'projects.deployments.receipt.headlineRemoveCancelled': ({ sha }) => `Removal of ${sha} cancelled`,
    'projects.deployments.receipt.titleRemoving': () => 'Removing',
    'projects.deployments.receipt.titleRemoved': () => 'Removed',
    'projects.deployments.receipt.titleRemoveFailed': () => 'Couldn’t remove',
    'projects.deployments.receipt.titleRemoveCancelled': () => 'Removal cancelled',
    'projects.deployments.headlineQueued': ({ sha }) => `${sha} is queued`,
    'projects.deployments.headlineUnknown': ({ sha }) => `Couldn’t confirm ${sha}`,
    'projects.deployments.headlineSkipped': ({ sha }) => sha
        ? `Skipped ${sha}. A newer push replaced it.` : 'Skipped. A newer push replaced it.',
} satisfies Record<HeadlineKey, (params: TitleParams) => string>;

export const DEPLOYMENT_RECEIPT_STATE_COPY_EN = {
    queued: 'Queued',
    running: 'Deploying',
    succeeded: 'Deployed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
    outcome_unknown: 'Outcome unknown',
} satisfies Record<SettledState, string>;

/** Historical receipts describe the recorded operation independently of live health. */
export function deploymentSettledReceiptStateV1(state: ReceiptState): SettledState {
    return state === 'running_unverified' ? 'succeeded' : state;
}

/** The same title for Receipt pages, History rows and evidence. Hosts can supply their locale. */
export function deploymentReceiptTitleV1(
    receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
    revisionLabel: string | null,
    copy: {
        headline(key: HeadlineKey, params: TitleParams): string;
        state(state: SettledState): string;
    } = {
        headline: (key, params) => DEPLOYMENT_RECEIPT_HEADLINE_COPY_EN[key](params),
        state: (state) => DEPLOYMENT_RECEIPT_STATE_COPY_EN[state],
    },
): string {
    const state = deploymentSettledReceiptStateV1(receipt.state);
    if (state === 'skipped') return copy.headline('projects.deployments.headlineSkipped', { sha: revisionLabel ?? '' });
    if (revisionLabel === null) {
        return receipt.operation === 'teardown' && state !== 'queued' && state !== 'outcome_unknown'
            ? copy.headline(UNVERSIONED_TEARDOWN_HEADLINES[state], { sha: '' }) : copy.state(state);
    }
    if (state === 'queued') return copy.headline('projects.deployments.headlineQueued', { sha: revisionLabel });
    if (state === 'outcome_unknown') return copy.headline('projects.deployments.headlineUnknown', { sha: revisionLabel });
    return copy.headline(OPERATION_HEADLINES[receipt.operation][state], { sha: revisionLabel });
}

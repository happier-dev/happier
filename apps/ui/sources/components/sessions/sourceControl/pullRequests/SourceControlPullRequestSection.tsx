import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useScmPullRequestOperations } from '@/hooks/session/sourceControl/useScmPullRequestOperations';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { PullRequestActionRail } from './PullRequestActionRail';
import { PullRequestStatusCard } from './PullRequestStatusCard';
import {
    buildPullRequestUiModel,
    type PullRequestCreateBlockedReason,
    type PullRequestUiModel,
} from './pullRequestUiModel';
import {
    SourceControlUpdateSection,
    type SourceControlUpdateTheme,
} from '../update/SourceControlUpdateControls';

export function SourceControlPullRequestSection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    writeEnabled?: boolean;
}>) {
    const model = React.useMemo(() => buildPullRequestUiModel(props.snapshot), [props.snapshot]);
    const operations = useScmPullRequestOperations({ sessionId: props.sessionId });
    const actionDisabled = props.disabled === true;
    const writeActionDisabled = props.writeEnabled !== true;

    return (
        <SourceControlUpdateSection
            theme={props.theme}
            title={t('files.sourceControlOperations.update.pullRequests.title')}
            testID="scm-update-pull-request-section"
        >
            {model.kind === 'existing_pull_request' || model.kind === 'ready_to_create' ? (
                <>
                    <PullRequestStatusCard theme={props.theme} model={model} />
                    {model.kind === 'ready_to_create' && model.createBlockedReason ? (
                        <PullRequestPolicyWarning
                            theme={props.theme}
                            reason={model.createBlockedReason}
                        />
                    ) : null}
                    {operations.status ? (
                        <Text
                            testID="scm-pull-request-operation-status"
                            style={{
                                fontSize: 11,
                                color: props.theme.colors.textSecondary,
                                ...Typography.default(),
                            }}
                        >
                            {operations.status}
                        </Text>
                    ) : null}
                    <PullRequestActionRail
                        theme={props.theme}
                        model={model}
                        disabled={actionDisabled}
                        writeDisabled={writeActionDisabled}
                        busy={operations.busy}
                        onViewPullRequest={(nextModel) => {
                            void operations.viewPullRequest(nextModel);
                        }}
                        onOpenOrReusePullRequest={(nextModel) => {
                            void operations.openOrReusePullRequest(nextModel);
                        }}
                        onCreateFeatureBranch={(nextModel) => {
                            void operations.createFeatureBranch(nextModel);
                        }}
                        onCreateFeatureBranchAndOpenPullRequest={(nextModel) => {
                            void operations.createFeatureBranchAndOpenPullRequest(nextModel);
                        }}
                    />
                </>
            ) : (
                <PullRequestUnavailableState theme={props.theme} model={model} />
            )}
        </SourceControlUpdateSection>
    );
}

function PullRequestUnavailableState(props: Readonly<{
    theme: SourceControlUpdateTheme;
    model: Exclude<PullRequestUiModel, { kind: 'existing_pull_request' | 'ready_to_create' }>;
}>) {
    return (
        <View testID="scm-pull-request-unavailable" style={{ gap: 4 }}>
            <Text style={{ fontSize: 12, color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                {getUnavailableTitle(props.model)}
            </Text>
            <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                {getUnavailableBody(props.model)}
            </Text>
        </View>
    );
}

function PullRequestPolicyWarning(props: Readonly<{
    theme: SourceControlUpdateTheme;
    reason: PullRequestCreateBlockedReason;
}>) {
    return (
        <Text
            testID="scm-pull-request-policy-warning"
            style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}
        >
            {props.reason === 'default_branch_denied'
                ? t('files.sourceControlOperations.update.pullRequests.defaultBranchDenied')
                : t('files.sourceControlOperations.update.pullRequests.defaultBranchRequiresFeature')}
        </Text>
    );
}

function getUnavailableTitle(model: Exclude<PullRequestUiModel, { kind: 'existing_pull_request' | 'ready_to_create' }>): string {
    switch (model.kind) {
        case 'not_repository':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.notRepositoryTitle');
        case 'unknown_provider':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.unknownProviderTitle');
        case 'no_branch':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.noBranchTitle');
        case 'detached_head':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.detachedHeadTitle');
    }
}

function getUnavailableBody(model: Exclude<PullRequestUiModel, { kind: 'existing_pull_request' | 'ready_to_create' }>): string {
    switch (model.kind) {
        case 'not_repository':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.notRepositoryBody');
        case 'unknown_provider':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.unknownProviderBody');
        case 'no_branch':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.noBranchBody');
        case 'detached_head':
            return t('files.sourceControlOperations.update.pullRequests.unavailable.detachedHeadBody');
    }
}

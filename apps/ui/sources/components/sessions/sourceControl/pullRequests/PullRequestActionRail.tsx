import * as React from 'react';
import { View } from 'react-native';

import { t } from '@/text';

import type { PullRequestUiModel } from './pullRequestUiModel';
import {
    SourceControlUpdateButton,
    type SourceControlUpdateTheme,
} from '../update/SourceControlUpdateControls';

type ExistingPullRequestModel = Extract<PullRequestUiModel, { kind: 'existing_pull_request' }>;
type ReadyPullRequestModel = Extract<PullRequestUiModel, { kind: 'ready_to_create' }>;

export function PullRequestActionRail(props: Readonly<{
    theme: SourceControlUpdateTheme;
    model: ExistingPullRequestModel | ReadyPullRequestModel;
    disabled?: boolean;
    writeDisabled?: boolean;
    busy?: boolean;
    onViewPullRequest: (model: ExistingPullRequestModel) => void;
    onOpenOrReusePullRequest: (model: ReadyPullRequestModel) => void;
    onCreateFeatureBranch: (model: ReadyPullRequestModel) => void;
    onCreateFeatureBranchAndOpenPullRequest: (model: ReadyPullRequestModel) => void;
}>) {
    const disabled = props.disabled === true || props.busy === true;
    const writeDisabled = disabled || props.writeDisabled === true;

    if (props.model.kind === 'existing_pull_request') {
        return (
            <View style={{ flexDirection: 'row', gap: 8 }}>
                <SourceControlUpdateButton
                    theme={props.theme}
                    testID="scm-pull-request-view"
                    label={t('files.sourceControlOperations.update.pullRequests.view')}
                    disabled={disabled}
                    kind="primary"
                    onPress={() => props.onViewPullRequest(props.model as ExistingPullRequestModel)}
                />
            </View>
        );
    }

    const defaultBranchAction = props.model.defaultBranchAction;
    if (defaultBranchAction?.kind === 'create_feature_branch_and_open_pr') {
        return (
            <View style={{ flexDirection: 'row', gap: 8 }}>
                <SourceControlUpdateButton
                    theme={props.theme}
                    testID="scm-pull-request-create-feature-branch-and-open-pr"
                    label={t('files.sourceControlOperations.update.pullRequests.createFeatureBranchAndOpen')}
                    disabled={writeDisabled || props.model.canCreatePullRequest !== true}
                    kind="primary"
                    onPress={() => props.onCreateFeatureBranchAndOpenPullRequest(props.model as ReadyPullRequestModel)}
                />
            </View>
        );
    }

    if (defaultBranchAction?.kind === 'create_feature_branch') {
        return (
            <View style={{ flexDirection: 'row', gap: 8 }}>
                <SourceControlUpdateButton
                    theme={props.theme}
                    testID="scm-pull-request-create-feature-branch"
                    label={t('files.sourceControlOperations.update.pullRequests.createFeatureBranch')}
                    disabled={writeDisabled}
                    kind="primary"
                    onPress={() => props.onCreateFeatureBranch(props.model as ReadyPullRequestModel)}
                />
            </View>
        );
    }

    const labelKey = props.model.createStrategy.kind === 'run_stacked_create_pr'
        ? 'files.sourceControlOperations.update.pullRequests.pushAndOpen'
        : 'files.sourceControlOperations.update.pullRequests.openOrReuse';
    return (
        <View style={{ flexDirection: 'row', gap: 8 }}>
            <SourceControlUpdateButton
                theme={props.theme}
                testID="scm-pull-request-open-or-reuse"
                label={t(labelKey)}
                disabled={
                    writeDisabled
                    || props.model.canCreatePullRequest !== true
                    || props.model.createBlockedReason !== null
                    || (
                        props.model.createStrategy.kind === 'open_or_reuse'
                        && props.model.createStrategy.disabledReason !== null
                    )
                }
                kind="primary"
                onPress={() => props.onOpenOrReusePullRequest(props.model as ReadyPullRequestModel)}
            />
        </View>
    );
}

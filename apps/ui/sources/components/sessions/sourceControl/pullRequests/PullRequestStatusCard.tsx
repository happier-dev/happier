import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { PullRequestUiModel } from './pullRequestUiModel';
import type { SourceControlUpdateTheme } from '../update/SourceControlUpdateControls';

type ExistingPullRequestModel = Extract<PullRequestUiModel, { kind: 'existing_pull_request' }>;
type ReadyPullRequestModel = Extract<PullRequestUiModel, { kind: 'ready_to_create' }>;

export function PullRequestStatusCard(props: Readonly<{
    theme: SourceControlUpdateTheme;
    model: ExistingPullRequestModel | ReadyPullRequestModel;
}>) {
    const isExisting = props.model.kind === 'existing_pull_request';
    const title = isExisting
        ? props.model.pullRequest.title
        : t('files.sourceControlOperations.update.pullRequests.readyTitle');
    const branchLabel = isExisting
        ? props.model.branchLabel
        : `${props.model.headBranch} -> ${props.model.baseBranch}`;
    const stateLabel = isExisting
        ? getPullRequestStateLabel(props.model.state)
        : t('files.sourceControlOperations.update.pullRequests.states.ready');
    const badgeLabel = isExisting
        ? [props.model.numberLabel, stateLabel].filter((value) => value.length > 0).join(' · ')
        : stateLabel;

    return (
        <View
            testID="scm-pull-request-status-card"
            style={{
                borderWidth: 1,
                borderColor: props.theme.colors.divider,
                borderRadius: 8,
                backgroundColor: props.theme.colors.surfaceHigh,
                padding: 10,
                gap: 8,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Text
                    numberOfLines={1}
                    style={{
                        flex: 1,
                        fontSize: 12,
                        color: props.theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {title}
                </Text>
                <Text
                    style={{
                        fontSize: 11,
                        color: props.theme.colors.textSecondary,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {badgeLabel}
                </Text>
            </View>
            <Text
                numberOfLines={1}
                style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}
            >
                {props.model.repositoryLabel} · {branchLabel}
            </Text>
        </View>
    );
}

function getPullRequestStateLabel(state: ExistingPullRequestModel['state']): string {
    switch (state) {
        case 'open':
            return t('files.sourceControlOperations.update.pullRequests.states.open');
        case 'closed':
            return t('files.sourceControlOperations.update.pullRequests.states.closed');
        case 'merged':
            return t('files.sourceControlOperations.update.pullRequests.states.merged');
        case 'unknown':
            return t('status.unknown');
    }
}

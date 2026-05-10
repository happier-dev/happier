import * as React from 'react';
import { View } from 'react-native';
import type {
    ScmBranchCreateResponse,
    ScmFollowupAction,
    ScmPullRequestOpenOrReuseResponse,
} from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { SourceControlUpdateButton, SourceControlUpdateSection, type SourceControlUpdateTheme } from './SourceControlUpdateControls';
import { resolveSourceControlPullRequestViewModel } from './resolveSourceControlPullRequestViewModel';
import { validateScmFollowupOpenUrl } from './validateScmFollowupOpenUrl';

export function SourceControlPullRequestSection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    onOpenOrReuse: (request: Readonly<{ base: string; head: string }>) => Promise<ScmPullRequestOpenOrReuseResponse>;
    onCreateFeatureBranch?: (request: Readonly<{ name: string; checkout: true; startPoint?: string }>) => Promise<ScmBranchCreateResponse>;
    onRefresh: () => Promise<void>;
    openUrl?: (url: string) => Promise<void>;
}>) {
    const model = resolveSourceControlPullRequestViewModel({
        snapshot: props.snapshot,
        disabled: props.disabled,
    });
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const openFollowup = React.useCallback(async (followup: Extract<ScmFollowupAction, { kind: 'openUrl' }>) => {
        const safe = validateScmFollowupOpenUrl(followup);
        if (!safe.ok) {
            setError(t('files.sourceControlOperations.update.pullRequest.unsafeUrl'));
            return;
        }
        await (props.openUrl ?? openExternalUrl)(safe.url);
    }, [props.openUrl]);

    const handleDefaultBranchRemediation = React.useCallback(async (
        action: Extract<NonNullable<typeof model.primaryAction>, { kind: 'open-or-reuse' }>,
        response: ScmPullRequestOpenOrReuseResponse,
    ): Promise<boolean> => {
        const remediation = readDefaultBranchRemediation(response);
        if (!remediation) return false;
        const confirmed = await Modal.confirm(
            t('files.sourceControlOperations.update.pullRequest.defaultBranch.confirmTitle'),
            t('files.sourceControlOperations.update.pullRequest.defaultBranch.confirmBody'),
            {
                confirmText: t('files.sourceControlOperations.update.pullRequest.defaultBranch.confirm'),
                cancelText: t('common.cancel'),
            },
        );
        if (!confirmed) return true;
        const featureBranchName = remediation.suggestedBranchName
            ?? deriveDefaultBranchFeatureBranchName({
                baseBranch: remediation.baseBranch ?? action.baseBranch,
                currentBranch: remediation.currentBranch ?? action.headBranch,
                ahead: remediation.ahead,
            });
        if (!props.onCreateFeatureBranch || !featureBranchName) {
            setError(readErrorMessage(response));
            return true;
        }
        const branchResponse = await props.onCreateFeatureBranch({
            name: featureBranchName,
            checkout: true,
            startPoint: remediation.currentBranch ?? action.headBranch,
        });
        if (!branchResponse.success) {
            setError(readErrorMessage(branchResponse) ?? readErrorMessage(response));
            return true;
        }
        if (remediation.kind === 'create_feature_branch_and_open_pr') {
            const retry = await props.onOpenOrReuse({
                base: remediation.baseBranch ?? action.baseBranch,
                head: featureBranchName,
            });
            if (!retry.success) {
                setError(readErrorMessage(retry));
                return true;
            }
            if (retry.nextAction.kind === 'openUrl') {
                await openFollowup(retry.nextAction);
            }
        }
        await props.onRefresh();
        return true;
    }, [openFollowup, props]);

    const runPrimary = React.useCallback(() => {
        void (async () => {
            const action = model.primaryAction;
            if (!action || action.disabled || busy) return;
            setBusy(true);
            setError(null);
            try {
                if (action.kind === 'open-url') {
                    await openFollowup(action.followup);
                    return;
                }
                if (action.kind === 'open-or-reuse') {
                    const response = await props.onOpenOrReuse({
                        base: action.baseBranch,
                        head: action.headBranch,
                    });
                    if (!response.success) {
                        if (await handleDefaultBranchRemediation(action, response)) {
                            return;
                        }
                        setError(readErrorMessage(response));
                        return;
                    }
                    if (response.nextAction.kind === 'openUrl') {
                        await openFollowup(response.nextAction);
                    }
                    await props.onRefresh();
                }
            } finally {
                setBusy(false);
            }
        })();
    }, [busy, handleDefaultBranchRemediation, model.primaryAction, openFollowup, props]);

    if (model.kind === 'unavailable') return null;

    return (
        <SourceControlUpdateSection
            theme={props.theme}
            title={t('files.sourceControlOperations.update.pullRequest.title')}
            testID="scm-pull-request-section"
        >
            <View style={{ gap: 8 }}>
                <Text style={{ fontSize: 12, color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                    {model.kind === 'existing'
                        ? model.title ?? t('files.sourceControlOperations.update.pullRequest.existing')
                        : t('files.sourceControlOperations.update.pullRequest.ready')}
                </Text>
                {model.baseBranch && model.headBranch ? (
                    <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.sourceControlOperations.update.pullRequest.branchPair', {
                            head: model.headBranch,
                            base: model.baseBranch,
                        })}
                    </Text>
                ) : null}
                {error ? (
                    <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                        {error}
                    </Text>
                ) : null}
                <SourceControlUpdateButton
                    theme={props.theme}
                    testID="scm-pull-request-primary"
                    label={model.kind === 'existing'
                        ? t('files.sourceControlOperations.update.pullRequest.open')
                        : t('files.sourceControlOperations.update.pullRequest.create')}
                    kind="primary"
                    disabled={busy || model.primaryAction?.disabled === true}
                    onPress={runPrimary}
                />
            </View>
        </SourceControlUpdateSection>
    );
}

type DefaultBranchRemediation = Readonly<{
    kind: 'create_feature_branch' | 'create_feature_branch_and_open_pr';
    baseBranch?: string;
    currentBranch?: string;
    ahead?: number;
    suggestedBranchName?: string;
}>;

function readDefaultBranchRemediation(response: ScmPullRequestOpenOrReuseResponse): DefaultBranchRemediation | null {
    if (response.success) return null;
    const candidate = readObjectField(response, 'remediation') ?? readObjectField(response, 'defaultBranchAction');
    if (!candidate) return null;
    const kind = candidate?.kind;
    if (kind !== 'create_feature_branch' && kind !== 'create_feature_branch_and_open_pr') return null;
    const suggestedBranchName = readStringField(candidate, 'suggestedBranchName');
    const baseBranch = readStringField(candidate, 'baseBranch');
    const currentBranch = readStringField(candidate, 'currentBranch');
    const ahead = readNonNegativeIntegerField(candidate, 'ahead');
    return {
        kind,
        ...(suggestedBranchName ? { suggestedBranchName } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(currentBranch ? { currentBranch } : {}),
        ...(ahead === null ? {} : { ahead }),
    };
}

function readObjectField(value: object, field: string): Record<string, unknown> | null {
    if (!(field in value)) return null;
    const candidate = (value as Record<string, unknown>)[field];
    return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null;
}

function readStringField(value: Record<string, unknown>, field: string): string | null {
    const candidate = value[field];
    return typeof candidate === 'string' && candidate.trim()
        ? candidate.trim()
        : null;
}

function readNonNegativeIntegerField(value: Record<string, unknown>, field: string): number | null {
    const candidate = value[field];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return null;
    return Math.max(0, Math.trunc(candidate));
}

function deriveDefaultBranchFeatureBranchName(input: Readonly<{
    baseBranch: string;
    currentBranch: string;
    ahead?: number;
}>): string | null {
    const source = input.currentBranch || input.baseBranch;
    const segment = normalizeGeneratedBranchSegment(source);
    if (!segment) return null;
    const suffix = input.ahead && input.ahead > 0
        ? `ahead-${input.ahead}`
        : 'changes';
    return `feature/${segment}-${suffix}`;
}

function normalizeGeneratedBranchSegment(value: string): string | null {
    const normalized = value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/-+/g, '-')
        .replace(/^[.-]+|[.-]+$/g, '');
    return normalized || null;
}

function readErrorMessage(value: object): string {
    return 'error' in value && typeof value.error === 'string'
        ? value.error
        : t('common.error');
}

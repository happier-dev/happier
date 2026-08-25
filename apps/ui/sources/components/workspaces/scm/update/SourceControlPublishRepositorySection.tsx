import * as React from 'react';
import { View } from 'react-native';
import type {
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmHostingRepositoryRemoteConflictStrategy,
    ScmHostingRepositoryRemoteUrlKind,
    ScmHostingRepositoryVisibility,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { SourceControlUpdateButton, SourceControlUpdateInput, SourceControlUpdateSection, type SourceControlUpdateTheme } from './SourceControlUpdateControls';
import { SourceControlUpdateDropdown } from './SourceControlUpdateDropdown';
import { SourceControlUpdateSwitchRow } from './SourceControlUpdateSwitchRow';
import {
    PublishRemediationAction,
    resolveRemediationHandlerAvailability,
    runPublishRemediationAction,
} from './PublishRemediationAction';
import {
    resolveSourceControlPublishRepositoryRemediation,
    type SourceControlPublishRemediationAction,
} from './resolveSourceControlPublishRepositoryRemediation';

type PublishTargetsSuccess = Extract<ScmHostingRepositoryDescribePublishTargetsResponse, { success: true }>;

function isGithubFamilyUrl(value: string | undefined): boolean {
    if (!value) return false;
    const scpStyleHost = value.match(/^[^@\s]+@([^:\s]+):/)?.[1]?.toLowerCase();
    if (scpStyleHost) {
        return scpStyleHost === 'github.com' || scpStyleHost.startsWith('github.');
    }
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === 'github.com' || host.startsWith('github.');
    } catch {
        return false;
    }
}

function hasGithubFamilyRemote(snapshot: ScmWorkingSnapshot): boolean {
    return (snapshot.repo.remotes ?? []).some((remote) => (
        isGithubFamilyUrl(remote.fetchUrl) || isGithubFamilyUrl(remote.pushUrl)
    ));
}

export function SourceControlPublishRepositorySection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    snapshot: ScmWorkingSnapshot | null;
    writeEnabled?: boolean;
    disabled?: boolean;
    publishTargets: ScmHostingRepositoryDescribePublishTargetsResponse | null;
    onDescribePublishTargets: () => Promise<ScmHostingRepositoryDescribePublishTargetsResponse>;
    onPublishRepository: (request: ScmHostingRepositoryPublishRequest) => Promise<ScmHostingRepositoryPublishResponse>;
    onRefresh: () => Promise<void>;
    onConnectGitHub?: () => Promise<void> | void;
    onInstallGh?: () => Promise<void> | void;
    onUseManagedGh?: () => Promise<void> | void;
    onAuthenticateGh?: () => Promise<void> | void;
    openUrl?: (url: string) => Promise<void>;
}>) {
    const snapshot = props.snapshot;
    const repoScopeKey = snapshot?.repo.isRepo === true
        ? `${snapshot.projectKey}:${snapshot.repo.rootPath ?? ''}:${snapshot.repo.backendId ?? ''}`
        : null;
    const [resolvedTargets, setResolvedTargets] = React.useState<ScmHostingRepositoryDescribePublishTargetsResponse | null>(props.publishTargets);
    const [resolvedTargetsScopeKey, setResolvedTargetsScopeKey] = React.useState<string | null>(repoScopeKey);
    const [loadingTargets, setLoadingTargets] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [errorCode, setErrorCode] = React.useState<string | null>(null);
    const [publishFailure, setPublishFailure] = React.useState<Extract<ScmHostingRepositoryPublishResponse, { success: false }> | null>(null);
    const [showRemoteConflictRemediation, setShowRemoteConflictRemediation] = React.useState(false);
    const [repositoryName, setRepositoryName] = React.useState('');
    const [selectedOwner, setSelectedOwner] = React.useState<string | null>(null);
    const [visibility, setVisibility] = React.useState<ScmHostingRepositoryVisibility>('private');
    const [remoteUrlKind, setRemoteUrlKind] = React.useState<ScmHostingRepositoryRemoteUrlKind>('https');
    const [remoteConflictStrategy, setRemoteConflictStrategy] = React.useState<ScmHostingRepositoryRemoteConflictStrategy>('fail');
    const [pushCurrentBranch, setPushCurrentBranch] = React.useState(true);
    const loadingTargetsScopeRef = React.useRef<string | null>(null);

    const canRender = snapshot?.repo.isRepo === true
        && props.writeEnabled === true
        && snapshot.capabilities?.readHostingRepositoryPublishTargets === true
        && snapshot.capabilities?.writeHostingRepositoryPublish === true
        && !hasGithubFamilyRemote(snapshot);
    const existingOriginRemote = snapshot?.repo.remotes?.find((remote) => remote.name === 'origin') ?? null;
    const activeResolvedTargets = resolvedTargetsScopeKey === repoScopeKey ? resolvedTargets : null;

    React.useEffect(() => {
        setResolvedTargetsScopeKey(repoScopeKey);
        setResolvedTargets(props.publishTargets);
    }, [props.publishTargets, repoScopeKey]);

    React.useEffect(() => {
        setRepositoryName('');
        setSelectedOwner(null);
        setVisibility('private');
        setRemoteUrlKind('https');
        setRemoteConflictStrategy('fail');
        setPushCurrentBranch(true);
        setErrorCode(null);
        setPublishFailure(null);
        setShowRemoteConflictRemediation(false);
    }, [repoScopeKey]);

    React.useEffect(() => {
        if (!canRender || props.publishTargets || !repoScopeKey) return;
        if (resolvedTargetsScopeKey === repoScopeKey && resolvedTargets) return;
        if (loadingTargetsScopeRef.current === repoScopeKey) return;
        let cancelled = false;
        const scopeKey = repoScopeKey;
        loadingTargetsScopeRef.current = scopeKey;
        setLoadingTargets(true);
        void props.onDescribePublishTargets()
            .then((response) => {
                if (!cancelled) {
                    setResolvedTargetsScopeKey(scopeKey);
                    setResolvedTargets(response);
                }
            })
            .finally(() => {
                if (loadingTargetsScopeRef.current === scopeKey) {
                    loadingTargetsScopeRef.current = null;
                }
                if (!cancelled) setLoadingTargets(false);
            });
        return () => {
            cancelled = true;
        };
    }, [canRender, props.onDescribePublishTargets, props.publishTargets, repoScopeKey, resolvedTargets, resolvedTargetsScopeKey]);

    const successTargets = activeResolvedTargets?.success === true ? activeResolvedTargets as PublishTargetsSuccess : null;
    const targetDiscoveryFailed = activeResolvedTargets?.success === false;
    /**
     * Re-arms the one loader above rather than adding a second fetch path: it runs whenever the
     * scope has no resolved targets. Without this the unknown state is terminal until the whole
     * screen remounts — switching sub-tabs deliberately does not refetch.
     */
    const retryDescribePublishTargets = React.useCallback(() => {
        setResolvedTargets(null);
    }, []);
    const targets = successTargets?.targets ?? [];
    const selectedTarget = targets.find((target) => target.owner === selectedOwner) ?? targets.find((target) => target.isDefault) ?? targets[0] ?? null;

    React.useEffect(() => {
        if (!successTargets) return;
        setRepositoryName((current) => current || successTargets.defaultRepositoryName);
    }, [successTargets]);

    React.useEffect(() => {
        if (!selectedTarget) return;
        setSelectedOwner((current) => current ?? selectedTarget.owner);
        setVisibility((current) => selectedTarget.supportedVisibilities.includes(current) ? current : selectedTarget.supportedVisibilities[0] ?? 'private');
        setRemoteUrlKind((current) => selectedTarget.supportedRemoteUrlKinds.includes(current) ? current : selectedTarget.supportedRemoteUrlKinds[0] ?? 'https');
    }, [selectedTarget]);

    const disabled = props.disabled === true || busy || loadingTargets || !selectedTarget;
    const remediationDisabled = props.disabled === true || busy || loadingTargets;
    const remediation = resolveSourceControlPublishRepositoryRemediation({
        targetsResponse: activeResolvedTargets,
        selectedTarget,
        publishFailure,
        disabled: remediationDisabled,
    });
    const publishAuth = selectedTarget?.auth ?? successTargets?.auth ?? null;
    const publishBlockedByAuth = selectedTarget !== null && publishAuth?.state !== 'authenticated';
    const publishBlockedByRemediation = remediation.action !== null || remediation.authUnavailable || publishBlockedByAuth;

    const submit = React.useCallback(() => {
        if (publishBlockedByRemediation || !selectedTarget || !repositoryName.trim()) return;
        void (async () => {
            setBusy(true);
            setErrorCode(null);
            setPublishFailure(null);
            try {
                const response = await props.onPublishRepository({
                    providerId: selectedTarget.provider.id,
                    providerKind: selectedTarget.provider.kind,
                    owner: selectedTarget.owner,
                    ownerKind: selectedTarget.ownerKind,
                    repositoryName: repositoryName.trim(),
                    visibility,
                    remoteName: 'origin',
                    remoteConflictStrategy: existingOriginRemote ? remoteConflictStrategy : undefined,
                    remoteUrlKind,
                    pushCurrentBranch,
                });
                if (!response.success) {
                    setErrorCode(response.errorCode ?? null);
                    setPublishFailure(response);
                    if (
                        response.errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS
                        || readProvisioningRemediationKind(response) === 'set_url_required'
                    ) {
                        setShowRemoteConflictRemediation(true);
                    }
                    return;
                }
                await props.onRefresh();
            } finally {
                setBusy(false);
            }
        })();
    }, [existingOriginRemote, props, publishBlockedByRemediation, pushCurrentBranch, remoteConflictStrategy, remoteUrlKind, repositoryName, selectedTarget, visibility]);

    if (!canRender) return null;

    const remediationAction = resolveRemediationHandlerAvailability(remediation.action, {
        onConnectGitHub: props.onConnectGitHub,
        onInstallGh: props.onInstallGh,
        onUseManagedGh: props.onUseManagedGh,
        onAuthenticateGh: props.onAuthenticateGh,
    });
    const ownerItems = targets.map((target) => ({
        id: target.owner,
        title: target.label,
        subtitle: target.provider.displayName,
    }));
    const visibilityItems = (selectedTarget?.supportedVisibilities ?? ['private']).map((item) => ({
        id: item,
        title: getPublishRepositoryVisibilityLabel(item),
    }));
    const remoteUrlKindItems = (selectedTarget?.supportedRemoteUrlKinds ?? ['https']).map((item) => ({
        id: item,
        title: getPublishRepositoryRemoteUrlKindLabel(item),
    }));
    const remoteConflictItems = [
        {
            id: 'fail',
            title: t('files.sourceControlOperations.update.publishRepository.keepOrigin'),
        },
        {
            id: 'set-url',
            title: t('files.sourceControlOperations.update.publishRepository.setOriginUrl'),
        },
    ];
    const runRemediationAction = (action: SourceControlPublishRemediationAction) => {
        void runPublishRemediationAction({
            action,
            openUrl: props.openUrl,
            onConnectGitHub: props.onConnectGitHub,
            onInstallGh: props.onInstallGh,
            onUseManagedGh: props.onUseManagedGh,
            onAuthenticateGh: props.onAuthenticateGh,
            setErrorCode,
        });
    };

    return (
        <SourceControlUpdateSection
            theme={props.theme}
            title={t('files.sourceControlOperations.update.publishRepository.title')}
            testID="scm-publish-repository-section"
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                {t('files.sourceControlOperations.update.publishRepository.body')}
            </Text>
            {successTargets ? (
                <View style={{ gap: 8 }}>
                    <SourceControlUpdateInput
                        theme={props.theme}
                        testID="scm-publish-repository-name-input"
                        accessibilityLabel={t('files.sourceControlOperations.update.publishRepository.repositoryNameLabel')}
                        placeholder={successTargets.defaultRepositoryName}
                        value={repositoryName}
                        editable={!disabled}
                        onChangeText={setRepositoryName}
                    />
                    <SourceControlUpdateDropdown
                        testID="scm-publish-owner-dropdown"
                        title={t('files.sourceControlOperations.update.publishRepository.ownerLabel')}
                        items={ownerItems}
                        selectedId={selectedTarget?.owner ?? ''}
                        disabled={disabled}
                        onSelect={setSelectedOwner}
                    />
                    <SourceControlUpdateDropdown
                        testID="scm-publish-visibility-dropdown"
                        title={t('files.sourceControlOperations.update.publishRepository.visibilityLabel')}
                        items={visibilityItems}
                        selectedId={visibility}
                        disabled={disabled}
                        onSelect={(value) => setVisibility(value as ScmHostingRepositoryVisibility)}
                    />
                    <SourceControlUpdateDropdown
                        testID="scm-publish-protocol-dropdown"
                        title={t('files.sourceControlOperations.update.publishRepository.remoteKindLabel')}
                        items={remoteUrlKindItems}
                        selectedId={remoteUrlKind}
                        disabled={disabled}
                        onSelect={(value) => setRemoteUrlKind(value as ScmHostingRepositoryRemoteUrlKind)}
                    />
                    {existingOriginRemote || showRemoteConflictRemediation ? (
                        <SourceControlUpdateDropdown
                            testID="scm-publish-existing-origin-dropdown"
                            title={t('files.sourceControlOperations.update.publishRepository.originConflictLabel')}
                            items={remoteConflictItems}
                            selectedId={remoteConflictStrategy}
                            disabled={disabled}
                            onSelect={(value) => setRemoteConflictStrategy(value as ScmHostingRepositoryRemoteConflictStrategy)}
                        />
                    ) : null}
                    <SourceControlUpdateSwitchRow
                        theme={props.theme}
                        testID="scm-publish-push-current-branch-switch"
                        label={t('files.sourceControlOperations.update.publishRepository.pushCurrentBranch')}
                        value={pushCurrentBranch}
                        disabled={disabled}
                        onValueChange={setPushCurrentBranch}
                    />
                    <PublishAuthState
                        theme={props.theme}
                        authState={remediation.authState}
                    />
                    <PublishRemediationAction
                        theme={props.theme}
                        action={remediationAction}
                        onRun={runRemediationAction}
                    />
                    {remediation.commitRequired ? (
                        <Text
                            testID="scm-publish-remediation-commit-required"
                            style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}
                        >
                            {t('files.sourceControlOperations.update.publishRepository.commitRequired')}
                        </Text>
                    ) : null}
                    {errorCode === 'UNSAFE_URL' ? (
                        <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.sourceControlOperations.update.publishRepository.unsafeUrl')}
                        </Text>
                    ) : null}
                    {showRemoteConflictRemediation || remediation.remoteConflict ? (
                        <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.sourceControlOperations.update.publishRepository.originConflictRemediation')}
                        </Text>
                    ) : null}
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-publish-repository-submit"
                        label={t('files.sourceControlOperations.update.publishRepository.publish')}
                        kind="primary"
                        disabled={disabled || publishBlockedByRemediation || !repositoryName.trim()}
                        onPress={submit}
                    />
                </View>
            ) : targetDiscoveryFailed ? (
                // `F-SCM-4`. Discovery FAILING is not the same fact as discovery reporting that
                // this host is not signed in, and this branch used to render the latter for both:
                // a daemon whose gh probe was cut short, or whose provider never resolved, told an
                // authenticated user to "sign in with gh CLI". A genuine negative arrives as
                // `success: true` with `auth.state: 'authentication_required'` and renders the
                // controls above with their own remediation, so everything here is the unknown
                // state — and it is recoverable, because the loader only reruns when the resolved
                // targets are cleared.
                <View style={{ gap: 8 }}>
                    <Text
                        testID="scm-publish-repository-unavailable"
                        style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}
                    >
                        {t('files.sourceControlOperations.update.publishRepository.targetsUnavailable')}
                    </Text>
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-publish-repository-retry"
                        label={t('common.retry')}
                        disabled={remediationDisabled}
                        onPress={retryDescribePublishTargets}
                    />
                    <PublishRemediationAction
                        theme={props.theme}
                        action={remediationAction}
                        onRun={runRemediationAction}
                    />
                </View>
            ) : (
                <View style={{ gap: 8 }}>
                    <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                        {t('common.loading')}
                    </Text>
                    <PublishRemediationAction
                        theme={props.theme}
                        action={remediationAction}
                        onRun={runRemediationAction}
                    />
                </View>
            )}
        </SourceControlUpdateSection>
    );
}

function getPublishRepositoryVisibilityLabel(visibility: ScmHostingRepositoryVisibility): string {
    switch (visibility) {
        case 'private':
            return t('files.sourceControlOperations.update.publishRepository.private');
        case 'public':
            return t('files.sourceControlOperations.update.publishRepository.public');
        case 'internal':
            return t('files.sourceControlOperations.update.publishRepository.internal');
    }
}

function getPublishRepositoryRemoteUrlKindLabel(kind: ScmHostingRepositoryRemoteUrlKind): string {
    switch (kind) {
        case 'https':
            return t('files.sourceControlOperations.update.publishRepository.httpsRemote');
        case 'ssh':
            return t('files.sourceControlOperations.update.publishRepository.sshRemote');
    }
}

function PublishAuthState(props: Readonly<{
    theme: SourceControlUpdateTheme;
    authState: 'connected-account-ready' | 'provider-cli-ready' | null;
}>) {
    if (!props.authState) return null;
    const testID = props.authState === 'provider-cli-ready'
        ? 'scm-publish-auth-provider-cli-ready'
        : 'scm-publish-auth-connected-account-ready';
    const label = props.authState === 'provider-cli-ready'
        ? t('files.sourceControlOperations.update.publishRepository.auth.providerCliReady')
        : t('files.sourceControlOperations.update.publishRepository.auth.connectedAccountReady');
    return (
        <Text
            testID={testID}
            style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}
        >
            {label}
        </Text>
    );
}

function readProvisioningRemediationKind(response: ScmHostingRepositoryPublishResponse): string | null {
    if (response.success || !('remediation' in response)) return null;
    const remediation = response.remediation;
    if (!remediation || typeof remediation !== 'object' || !('kind' in remediation)) return null;
    return typeof remediation.kind === 'string' ? remediation.kind : null;
}

import * as React from 'react';
import { View } from 'react-native';
import type {
    ScmFollowupAction,
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
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { SourceControlUpdateButton, SourceControlUpdateInput, SourceControlUpdateSection, type SourceControlUpdateTheme } from './SourceControlUpdateControls';
import { SourceControlUpdateDropdown } from './SourceControlUpdateDropdown';
import { SourceControlUpdateSwitchRow } from './SourceControlUpdateSwitchRow';
import {
    resolveSourceControlPublishRepositoryRemediation,
    type SourceControlPublishRemediationAction,
} from './resolveSourceControlPublishRepositoryRemediation';
import { validateScmFollowupOpenUrl } from './validateScmFollowupOpenUrl';

type PublishTargetsSuccess = Extract<ScmHostingRepositoryDescribePublishTargetsResponse, { success: true }>;
type PublishRemediationHandlers = Readonly<{
    onConnectGitHub?: () => Promise<void> | void;
    onInstallGh?: () => Promise<void> | void;
    onUseManagedGh?: () => Promise<void> | void;
    onAuthenticateGh?: () => Promise<void> | void;
}>;

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

    const submit = React.useCallback(() => {
        if (!selectedTarget || !repositoryName.trim()) return;
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
    }, [existingOriginRemote, props, pushCurrentBranch, remoteConflictStrategy, remoteUrlKind, repositoryName, selectedTarget, visibility]);

    if (!canRender) return null;

    const disabled = props.disabled === true || busy || loadingTargets || !selectedTarget;
    const remediation = resolveSourceControlPublishRepositoryRemediation({
        targetsResponse: activeResolvedTargets,
        selectedTarget,
        publishFailure,
        disabled,
    });
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
        title: t(`files.sourceControlOperations.update.publish.visibility.${item}`),
    }));
    const remoteUrlKindItems = (selectedTarget?.supportedRemoteUrlKinds ?? ['https']).map((item) => ({
        id: item,
        title: t(`files.sourceControlOperations.update.publish.protocol.${item}`),
    }));
    const remoteConflictItems = [
        {
            id: 'fail',
            title: t('files.sourceControlOperations.update.publish.remoteConflict.fail'),
        },
        {
            id: 'set-url',
            title: t('files.sourceControlOperations.update.publish.remoteConflict.setUrl'),
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
            title={t('files.sourceControlOperations.update.publish.title')}
            testID="scm-publish-repository-section"
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                {t('files.sourceControlOperations.update.publish.description')}
            </Text>
            {successTargets ? (
                <View style={{ gap: 8 }}>
                    <SourceControlUpdateInput
                        theme={props.theme}
                        testID="scm-publish-repository-name-input"
                        accessibilityLabel={t('files.sourceControlOperations.update.publish.repositoryNameLabel')}
                        placeholder={successTargets.defaultRepositoryName}
                        value={repositoryName}
                        editable={!disabled}
                        onChangeText={setRepositoryName}
                    />
                    <SourceControlUpdateDropdown
                        testID="scm-publish-owner-dropdown"
                        title={t('files.sourceControlOperations.update.publish.ownerLabel')}
                        items={ownerItems}
                        selectedId={selectedTarget?.owner ?? ''}
                        disabled={disabled}
                        onSelect={setSelectedOwner}
                    />
                    <SourceControlUpdateDropdown
                        testID="scm-publish-visibility-dropdown"
                        title={t('files.sourceControlOperations.update.publish.visibilityLabel')}
                        items={visibilityItems}
                        selectedId={visibility}
                        disabled={disabled}
                        onSelect={(value) => setVisibility(value as ScmHostingRepositoryVisibility)}
                    />
                    <SourceControlUpdateDropdown
                        testID="scm-publish-protocol-dropdown"
                        title={t('files.sourceControlOperations.update.publish.protocolLabel')}
                        items={remoteUrlKindItems}
                        selectedId={remoteUrlKind}
                        disabled={disabled}
                        onSelect={(value) => setRemoteUrlKind(value as ScmHostingRepositoryRemoteUrlKind)}
                    />
                    {existingOriginRemote || showRemoteConflictRemediation ? (
                        <SourceControlUpdateDropdown
                            testID="scm-publish-existing-origin-dropdown"
                            title={t('files.sourceControlOperations.update.publish.remoteConflict.label')}
                            items={remoteConflictItems}
                            selectedId={remoteConflictStrategy}
                            disabled={disabled}
                            onSelect={(value) => setRemoteConflictStrategy(value as ScmHostingRepositoryRemoteConflictStrategy)}
                        />
                    ) : null}
                    <SourceControlUpdateSwitchRow
                        theme={props.theme}
                        testID="scm-publish-push-current-branch-switch"
                        label={t('files.sourceControlOperations.update.publish.pushCurrentBranch')}
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
                            {t('files.sourceControlOperations.update.publish.commitRequired')}
                        </Text>
                    ) : null}
                    {errorCode === 'UNSAFE_URL' ? (
                        <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.sourceControlOperations.update.publish.unsafeUrl')}
                        </Text>
                    ) : null}
                    {showRemoteConflictRemediation || remediation.remoteConflict ? (
                        <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.sourceControlOperations.update.publish.remoteConflict.remediation')}
                        </Text>
                    ) : null}
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-publish-repository-submit"
                        label={t('files.sourceControlOperations.update.publish.submit')}
                        kind="primary"
                        disabled={disabled || !repositoryName.trim()}
                        onPress={submit}
                    />
                </View>
            ) : (
                <View style={{ gap: 8 }}>
                    <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                        {activeResolvedTargets?.success === false
                            ? t('files.sourceControlOperations.update.publish.unavailable')
                            : t('common.loading')}
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

function PublishAuthState(props: Readonly<{
    theme: SourceControlUpdateTheme;
    authState: 'connected-account-ready' | 'provider-cli-ready' | null;
}>) {
    if (!props.authState) return null;
    const testID = props.authState === 'provider-cli-ready'
        ? 'scm-publish-auth-provider-cli-ready'
        : 'scm-publish-auth-connected-account-ready';
    const label = props.authState === 'provider-cli-ready'
        ? t('files.sourceControlOperations.update.publish.auth.providerCliReady')
        : t('files.sourceControlOperations.update.publish.auth.connectedAccountReady');
    return (
        <Text
            testID={testID}
            style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default() }}
        >
            {label}
        </Text>
    );
}

function PublishRemediationAction(props: Readonly<{
    theme: SourceControlUpdateTheme;
    action: SourceControlPublishRemediationAction | null;
    onRun: (action: SourceControlPublishRemediationAction) => void;
}>) {
    const action = props.action;
    if (!action) return null;
    return (
        <SourceControlUpdateButton
            theme={props.theme}
            testID={getPublishRemediationActionTestId(action)}
            label={getPublishRemediationActionLabel(action)}
            kind="secondary"
            disabled={action.disabled}
            onPress={() => props.onRun(action)}
        />
    );
}

async function runPublishRemediationAction(input: Readonly<{
    action: SourceControlPublishRemediationAction;
    openUrl?: (url: string) => Promise<void>;
    onConnectGitHub?: () => Promise<void> | void;
    onInstallGh?: () => Promise<void> | void;
    onUseManagedGh?: () => Promise<void> | void;
    onAuthenticateGh?: () => Promise<void> | void;
    setErrorCode: (value: string | null) => void;
}>) {
    if (input.action.kind === 'connect-github') {
        await input.onConnectGitHub?.();
        return;
    }
    if (input.action.kind === 'install-gh') {
        await input.onInstallGh?.();
        return;
    }
    if (input.action.kind === 'use-managed-gh') {
        await input.onUseManagedGh?.();
        return;
    }
    if (input.action.kind === 'authenticate-gh') {
        await input.onAuthenticateGh?.();
        return;
    }
    await openValidatedPublishFollowup(input.action.followup, input.openUrl, input.setErrorCode);
}

function resolveRemediationHandlerAvailability(
    action: SourceControlPublishRemediationAction | null,
    handlers: PublishRemediationHandlers,
): SourceControlPublishRemediationAction | null {
    if (!action) return null;
    if (action.disabled) return action;
    if (hasPublishRemediationHandler(action, handlers)) return action;
    return { ...action, disabled: true };
}

function hasPublishRemediationHandler(
    action: SourceControlPublishRemediationAction,
    handlers: PublishRemediationHandlers,
): boolean {
    switch (action.kind) {
        case 'connect-github':
            return Boolean(handlers.onConnectGitHub);
        case 'install-gh':
            return Boolean(handlers.onInstallGh);
        case 'use-managed-gh':
            return Boolean(handlers.onUseManagedGh);
        case 'authenticate-gh':
            return Boolean(handlers.onAuthenticateGh);
        case 'open-browser':
            return true;
    }
}

async function openValidatedPublishFollowup(
    followup: Extract<ScmFollowupAction, { kind: 'openUrl' }>,
    openUrl: ((url: string) => Promise<void>) | undefined,
    setErrorCode: (value: string | null) => void,
) {
    const safe = validateScmFollowupOpenUrl(followup);
    if (!safe.ok) {
        setErrorCode('UNSAFE_URL');
        return;
    }
    await (openUrl ?? openExternalUrl)(safe.url);
}

function getPublishRemediationActionTestId(action: SourceControlPublishRemediationAction): string {
    switch (action.kind) {
        case 'connect-github':
            return 'scm-publish-remediation-connect-github';
        case 'install-gh':
            return 'scm-publish-remediation-install-gh';
        case 'use-managed-gh':
            return 'scm-publish-remediation-use-managed-gh';
        case 'authenticate-gh':
            return 'scm-publish-remediation-authenticate-gh';
        case 'open-browser':
            return 'scm-publish-remediation-open-browser';
    }
}

function getPublishRemediationActionLabel(action: SourceControlPublishRemediationAction): string {
    switch (action.kind) {
        case 'connect-github':
            return t('files.sourceControlOperations.update.publish.remediation.connectGitHub');
        case 'install-gh':
            return t('files.sourceControlOperations.update.publish.remediation.installGh');
        case 'use-managed-gh':
            return t('files.sourceControlOperations.update.publish.remediation.useManagedGh');
        case 'authenticate-gh':
            return t('files.sourceControlOperations.update.publish.remediation.authenticateGh');
        case 'open-browser':
            return t('files.sourceControlOperations.update.publish.remediation.openBrowser');
    }
}

function readProvisioningRemediationKind(response: ScmHostingRepositoryPublishResponse): string | null {
    if (response.success || !('remediation' in response)) return null;
    const remediation = response.remediation;
    if (!remediation || typeof remediation !== 'object' || !('kind' in remediation)) return null;
    return typeof remediation.kind === 'string' ? remediation.kind : null;
}

import * as React from 'react';
import { View } from 'react-native';
import type {
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositoryRemoteConflictStrategy,
    ScmHostingRepositoryRemoteUrlKind,
    ScmHostingRepositoryVisibility,
} from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmHostingRepositoryDescribePublishTargets,
    sessionScmHostingRepositoryPublish,
} from '@/sync/ops/sessions';
import { t } from '@/text';

import {
    SourceControlUpdateButton,
    SourceControlUpdateInput,
    SourceControlUpdateSection,
    type SourceControlUpdateTheme,
} from './SourceControlUpdateControls';
import {
    SourceControlUpdateDropdown,
    type SourceControlUpdateDropdownItem,
} from './SourceControlUpdateDropdown';
import { SourceControlUpdateSwitchRow } from './SourceControlUpdateSwitchRow';

const DEFAULT_REMOTE_NAME = 'origin';

function pickDefaultTarget(
    targets: readonly ScmHostingRepositoryPublishTarget[],
): ScmHostingRepositoryPublishTarget | null {
    return targets.find((target) => target.default === true) ?? targets[0] ?? null;
}

function isPublishSectionAvailable(props: Readonly<{
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    writeEnabled?: boolean;
}>): boolean {
    const snapshot = props.snapshot;
    if (!snapshot?.repo.isRepo) return false;
    if (props.disabled === true || props.writeEnabled !== true) return false;
    if (snapshot.capabilities?.readHostingRepositoryPublishTargets !== true) return false;
    if (snapshot.capabilities?.writeHostingRepositoryPublish !== true) return false;
    if (snapshot.hostingProvider?.kind === 'github') return false;
    return !(snapshot.repo.remotes ?? []).some((remote) => (
        isGithubRemoteUrl(remote.fetchUrl) || isGithubRemoteUrl(remote.pushUrl)
    ));
}

function isGithubRemoteUrl(value: string | undefined): boolean {
    const host = readRemoteHost(value);
    return host === 'github.com' || host?.startsWith('github.') === true;
}

function readRemoteHost(value: string | undefined): string | null {
    const remoteUrl = String(value ?? '').trim();
    if (!remoteUrl) return null;
    try {
        const parsed = new URL(remoteUrl);
        return parsed.hostname.toLowerCase() || null;
    } catch {
        const match = /^(?:[^@\s]+@)?([^:\s]+):.+$/.exec(remoteUrl);
        return match?.[1]?.trim().toLowerCase() || null;
    }
}

export function SourceControlPublishRepositorySection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    writeEnabled?: boolean;
}>) {
    const available = isPublishSectionAvailable(props);
    const [busy, setBusy] = React.useState(false);
    const [targets, setTargets] = React.useState<readonly ScmHostingRepositoryPublishTarget[]>([]);
    const [selectedOwner, setSelectedOwner] = React.useState<string | null>(null);
    const [repositoryName, setRepositoryName] = React.useState('');
    const [visibility, setVisibility] = React.useState<ScmHostingRepositoryVisibility>('private');
    const [remoteUrlKind, setRemoteUrlKind] = React.useState<ScmHostingRepositoryRemoteUrlKind>('https');
    const [remoteConflictStrategy, setRemoteConflictStrategy] =
        React.useState<ScmHostingRepositoryRemoteConflictStrategy>('fail');
    const [pushCurrentBranch, setPushCurrentBranch] = React.useState(false);
    const [loadFailed, setLoadFailed] = React.useState(false);

    React.useEffect(() => {
        if (!available) return;
        let cancelled = false;
        void (async () => {
            setLoadFailed(false);
            const response = await sessionScmHostingRepositoryDescribePublishTargets(props.sessionId, {
                providerKind: 'github',
            });
            if (cancelled) return;
            if (!response.success) {
                setTargets([]);
                setSelectedOwner(null);
                setLoadFailed(true);
                return;
            }
            const nextTargets = response.targets;
            const defaultTarget = pickDefaultTarget(nextTargets);
            setTargets(nextTargets);
            setSelectedOwner(defaultTarget?.owner ?? null);
            if (response.defaultRepositoryName) {
                setRepositoryName((current) => (
                    current.trim().length === 0 ? response.defaultRepositoryName ?? current : current
                ));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [available, props.sessionId]);

    const selectedTarget =
        targets.find((target) => target.owner === selectedOwner)
        ?? pickDefaultTarget(targets);

    React.useEffect(() => {
        if (!selectedTarget) return;
        if (selectedTarget.supportedVisibilities.includes(visibility)) return;
        setVisibility(selectedTarget.supportedVisibilities[0] ?? 'private');
    }, [selectedTarget, visibility]);

    if (!available) return null;

    const controlsDisabled = busy || targets.length === 0 || loadFailed;
    const hasOriginRemote = props.snapshot?.repo.remotes?.some((remote) => remote.name === DEFAULT_REMOTE_NAME) === true;
    const ownerItems: readonly SourceControlUpdateDropdownItem[] = targets.map((target) => ({
        id: `owner:${target.owner}`,
        title: target.label ?? target.owner,
        subtitle: target.ownerKind,
    }));
    const selectedOwnerId = selectedTarget ? `owner:${selectedTarget.owner}` : '';
    const visibilityItems: readonly SourceControlUpdateDropdownItem[] = (selectedTarget?.supportedVisibilities ?? []).map((value) => ({
        id: `visibility:${value}`,
        title: visibilityLabel(value),
    }));
    const remoteKindItems: readonly SourceControlUpdateDropdownItem[] = [
        {
            id: 'remote-kind:https',
            title: t('files.sourceControlOperations.update.publishRepository.httpsRemote'),
        },
        {
            id: 'remote-kind:ssh',
            title: t('files.sourceControlOperations.update.publishRepository.sshRemote'),
        },
    ];
    const remoteConflictItems: readonly SourceControlUpdateDropdownItem[] = [
        {
            id: 'remote-conflict:fail',
            title: t('files.sourceControlOperations.update.publishRepository.keepOrigin'),
        },
        {
            id: 'remote-conflict:set-url',
            title: t('files.sourceControlOperations.update.publishRepository.setOriginUrl'),
        },
    ];

    const publish = () => {
        void (async () => {
            const target = selectedTarget;
            const trimmedRepositoryName = repositoryName.trim();
            if (!target) {
                Modal.alert(t('common.error'), t('files.sourceControlOperations.update.publishRepository.errors.targetRequired'));
                return;
            }
            if (!trimmedRepositoryName) {
                Modal.alert(t('common.error'), t('files.sourceControlOperations.update.publishRepository.errors.nameRequired'));
                return;
            }

            setBusy(true);
            try {
                const response = await sessionScmHostingRepositoryPublish(props.sessionId, {
                    providerKind: 'github',
                    owner: target.owner,
                    ownerKind: target.ownerKind,
                    repositoryName: trimmedRepositoryName,
                    visibility,
                    remoteName: DEFAULT_REMOTE_NAME,
                    remoteConflictStrategy,
                    remoteUrlKind,
                    pushCurrentBranch,
                });
                if (!response.success) {
                    Modal.alert(
                        t('common.error'),
                        response.error || t('files.sourceControlOperations.update.publishRepository.errors.publishFailed'),
                    );
                    return;
                }
                await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
            } finally {
                setBusy(false);
            }
        })();
    };

    return (
        <SourceControlUpdateSection
            theme={props.theme}
            title={t('files.sourceControlOperations.update.publishRepository.title')}
            testID="scm-publish-repository-section"
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                {t('files.sourceControlOperations.update.publishRepository.body')}
            </Text>

            {targets.length > 1 ? (
                <SourceControlUpdateDropdown
                    theme={props.theme}
                    testID="scm-publish-owner-dropdown"
                    label={t('files.sourceControlOperations.update.publishRepository.ownerLabel')}
                    items={ownerItems}
                    selectedId={selectedOwnerId}
                    disabled={busy}
                    onSelect={(itemId) => {
                        const nextOwner = itemId.startsWith('owner:') ? itemId.slice('owner:'.length) : itemId;
                        setSelectedOwner(nextOwner);
                    }}
                />
            ) : null}

            {loadFailed ? (
                <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                    {t('files.sourceControlOperations.update.publishRepository.errors.loadTargetsFailed')}
                </Text>
            ) : null}

            {targets.length === 0 && !loadFailed ? (
                <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                    {t('files.sourceControlOperations.update.publishRepository.noTargets')}
                </Text>
            ) : null}

            <SourceControlUpdateInput
                theme={props.theme}
                testID="scm-publish-repository-name"
                accessibilityLabel={t('files.sourceControlOperations.update.publishRepository.repositoryNameLabel')}
                placeholder={t('files.sourceControlOperations.update.publishRepository.repositoryNamePlaceholder')}
                value={repositoryName}
                editable={!controlsDisabled}
                onChangeText={setRepositoryName}
            />

            <SourceControlUpdateDropdown
                theme={props.theme}
                testID="scm-publish-visibility-dropdown"
                label={t('files.sourceControlOperations.update.publishRepository.visibilityLabel')}
                items={visibilityItems}
                selectedId={`visibility:${visibility}`}
                disabled={controlsDisabled}
                onSelect={(itemId) => {
                    const value = itemId.replace(/^visibility:/, '') as ScmHostingRepositoryVisibility;
                    setVisibility(value);
                }}
            />

            <SourceControlUpdateDropdown
                theme={props.theme}
                testID="scm-publish-remote-kind-dropdown"
                label={t('files.sourceControlOperations.update.publishRepository.remoteKindLabel')}
                items={remoteKindItems}
                selectedId={`remote-kind:${remoteUrlKind}`}
                disabled={controlsDisabled}
                onSelect={(itemId) => {
                    const value = itemId.replace(/^remote-kind:/, '') as ScmHostingRepositoryRemoteUrlKind;
                    setRemoteUrlKind(value);
                }}
            />

            <SourceControlUpdateSwitchRow
                theme={props.theme}
                testID="scm-publish-push-toggle"
                label={t('files.sourceControlOperations.update.publishRepository.pushCurrentBranch')}
                value={pushCurrentBranch}
                disabled={controlsDisabled}
                onValueChange={setPushCurrentBranch}
            />

            {hasOriginRemote ? (
                <SourceControlUpdateDropdown
                    theme={props.theme}
                    testID="scm-publish-origin-conflict-dropdown"
                    label={t('files.sourceControlOperations.update.publishRepository.originConflictLabel')}
                    items={remoteConflictItems}
                    selectedId={`remote-conflict:${remoteConflictStrategy}`}
                    disabled={controlsDisabled}
                    onSelect={(itemId) => {
                        const value = itemId.replace(/^remote-conflict:/, '') as ScmHostingRepositoryRemoteConflictStrategy;
                        setRemoteConflictStrategy(value);
                    }}
                />
            ) : null}

            <SourceControlUpdateButton
                theme={props.theme}
                testID="scm-publish-repository-submit"
                label={busy
                    ? t('files.sourceControlOperations.update.publishRepository.publishing')
                    : t('files.sourceControlOperations.update.publishRepository.publish')}
                kind="primary"
                disabled={controlsDisabled}
                onPress={publish}
            />
        </SourceControlUpdateSection>
    );
}

function visibilityLabel(visibility: ScmHostingRepositoryVisibility): string {
    switch (visibility) {
        case 'private':
            return t('files.sourceControlOperations.update.publishRepository.private');
        case 'public':
            return t('files.sourceControlOperations.update.publishRepository.public');
        case 'internal':
            return t('files.sourceControlOperations.update.publishRepository.internal');
    }
}

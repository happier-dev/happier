import * as React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { sync } from '@/sync/sync';

import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverrides, deleteRemoteHostLocalOverrides, upsertRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { resolveRemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { useSshSystemTaskPromptModals } from '@/components/systemTasks/ssh/useSshSystemTaskPromptModals';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';

import { RemoteHostForm } from './RemoteHostForm';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

function sortByLastUsedDesc(hosts: readonly RemoteHost[]): RemoteHost[] {
    return [...hosts].sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0));
}

function upsertRemoteHost(list: readonly RemoteHost[], remoteHost: RemoteHost): RemoteHost[] {
    const next = [...list];
    const index = next.findIndex((entry) => entry.id === remoteHost.id);
    if (index >= 0) {
        next[index] = remoteHost;
        return next;
    }
    next.push(remoteHost);
    return next;
}

function removeRemoteHost(list: readonly RemoteHost[], remoteHostId: string): RemoteHost[] {
    return list.filter((entry) => entry.id !== remoteHostId);
}

export const RemoteHostsScreen = React.memo(function RemoteHostsScreen() {
    const isDesktop = isTauriDesktop();
    const { theme } = useUnistyles();
    const supportsWholeRowPress = Platform.OS !== 'web';
    const [remoteHosts, setRemoteHosts] = useSettingMutable('remoteHostsV1');
    const hosts = React.useMemo(() => sortByLastUsedDesc(remoteHosts ?? []), [remoteHosts]);
    useSettings(); // Ensure settings are hydrated for feature decisions.
    const remoteHostsManagementEnabled = useFeatureEnabled('remoteHosts.management');
    const secretMaterialAllowed = useFeatureEnabled('remoteHosts.secretMaterial');

    if (!isDesktop) {
        return (
            <ItemList>
                <ItemGroup title={t('settings.remoteHostsTitle')}>
                    <Item
                        testID="settings.remoteHosts.desktopOnly"
                        title={t('settings.remoteHostsDesktopOnlyTitle')}
                        subtitle={t('settings.remoteHostsDesktopOnlySubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (!remoteHostsManagementEnabled) {
        return (
            <ItemList>
                <ItemGroup title={t('settings.remoteHostsTitle')}>
                    <Item
                        testID="settings.remoteHosts.managementDisabled"
                        title={t('settings.remoteHostsManagementDisabledTitle')}
                        subtitle={t('settings.remoteHostsManagementDisabledSubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <RemoteHostsScreenBody
            hosts={hosts}
            remoteHosts={remoteHosts}
            setRemoteHosts={setRemoteHosts}
            secretMaterialAllowed={secretMaterialAllowed}
            supportsWholeRowPress={supportsWholeRowPress}
            themeTextSecondary={theme.colors.textSecondary}
        />
    );
});

const RemoteHostsScreenBody = React.memo(function RemoteHostsScreenBody(props: Readonly<{
    hosts: RemoteHost[];
    remoteHosts: RemoteHost[] | null;
    setRemoteHosts: (value: RemoteHost[]) => void;
    secretMaterialAllowed: boolean;
    supportsWholeRowPress: boolean;
    themeTextSecondary: string;
}>) {
    const runner = getDefaultSystemTaskRunner();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [activeTaskTitle, setActiveTaskTitle] = React.useState<string | null>(null);
    const [activeTaskAction, setActiveTaskAction] = React.useState<string | null>(null);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const latestPrompt = React.useMemo(() => readLatestSystemTaskPrompt(activeTaskSnapshot), [activeTaskSnapshot]);
    useSshSystemTaskPromptModals({
        runner,
        taskId: activeTaskId,
        snapshot: activeTaskSnapshot,
        prompt: latestPrompt,
    });

    React.useEffect(() => {
        if (!activeTaskId) return;
        const result = activeTaskSnapshot?.result;
        if (!result) return;
        void (async () => {
            try {
                if (result.ok) {
                    if (activeTaskAction === 'testConnection') {
                        Modal.alert(t('common.success'), t('settings.remoteHostsConnectionSucceeded'));
                    } else {
                        Modal.alert(t('common.success'), activeTaskTitle ?? t('common.success'));
                    }
                } else {
                    const message = result.error.message || t('settings.remoteHostsConnectionFailed');
                    Modal.alert(t('common.error'), message);
                }
            } finally {
                setActiveTaskId(null);
                setActiveTaskTitle(null);
                setActiveTaskAction(null);
            }
        })();
    }, [activeTaskAction, activeTaskId, activeTaskSnapshot?.result, activeTaskTitle]);

    const startManageHostAction = React.useCallback(async (
        remoteHost: RemoteHost,
        action: Parameters<typeof buildRemoteSshManageHostSystemTaskSpec>[0]['action'],
        title: string,
    ) => {
        try {
            const localOverrides = getRemoteHostLocalOverrides(remoteHost.id);
            const resolved = await resolveRemoteHostEffectiveSshConfig({
                remoteHost,
                localOverrides,
                secretMaterialAllowed: props.secretMaterialAllowed,
                decryptSecretValue: (input) => sync.decryptSecretValue(input),
            });
            if (!resolved.ok) {
                Modal.alert(t('common.error'), resolved.error.message);
                return;
            }

            const spec = buildRemoteSshManageHostSystemTaskSpec({
                action,
                channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                sshTarget: resolved.value.sshTarget,
                sshPort: resolved.value.sshPort ? String(resolved.value.sshPort) : '',
                sshAuth: resolved.value.sshAuth,
                identityFilePath: resolved.value.identityFilePath,
                identityPrivateKey: resolved.value.identityPrivateKey,
                sshConfigFilePath: resolved.value.sshConfigFilePath,
                sshPassword: resolved.value.password,
                knownHostsMode: 'app',
                serviceMode: 'user',
                relayRuntime: {
                    channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                    mode: 'user',
                },
            });
            const taskId = await runner.start(spec);
            setActiveTaskId(taskId);
            setActiveTaskTitle(title);
            setActiveTaskAction(action);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.remoteHostsConnectionFailed'));
        }
    }, [props.secretMaterialAllowed, runner]);

    const openEditor = React.useCallback((remoteHostId: string | null) => {
        const existing = remoteHostId ? props.hosts.find((entry) => entry.id === remoteHostId) ?? null : null;
        const localOverrides = existing ? getRemoteHostLocalOverrides(existing.id) : null;

        Modal.show({
            component: RemoteHostForm,
            props: {
                remoteHost: existing,
                localOverrides,
                secretMaterialAllowed: props.secretMaterialAllowed,
                onSave: ({ remoteHost, localOverrides }) => {
                    const nextList = upsertRemoteHost(props.remoteHosts ?? [], remoteHost);
                    props.setRemoteHosts(nextList);
                    upsertRemoteHostLocalOverrides(remoteHost.id, localOverrides);
                },
                onDelete: (id) => {
                    props.setRemoteHosts(removeRemoteHost(props.remoteHosts ?? [], id));
                    deleteRemoteHostLocalOverrides(id);
                },
                onTestConnection: (host) => void startManageHostAction(host, 'testConnection', t('settings.remoteHostsTestConnectionTitle')),
            },
            closeOnBackdrop: true,
        });
    }, [props.hosts, props.remoteHosts, props.secretMaterialAllowed, props.setRemoteHosts, startManageHostAction]);

    return (
        <ItemList>
            <ItemGroup title={t('settings.remoteHostsTitle')}>
                {props.hosts.length === 0 ? (
                    <Item
                        testID="settings.remoteHosts.empty"
                        title={t('settings.remoteHostsEmptyTitle')}
                        subtitle={t('settings.remoteHostsEmptySubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {props.hosts.map((host) => (
                    (() => {
                        const actions: ItemAction[] = [
                            {
                                id: 'testConnection',
                                title: t('settings.remoteHostsTestConnectionTitle'),
                                icon: 'pulse-outline',
                                inlineTestID: 'settings.remoteHosts.action.testConnection',
                                onPress: () => void startManageHostAction(host, 'testConnection', t('settings.remoteHostsTestConnectionTitle')),
                            },
                            {
                                id: 'installOrUpdateCli',
                                title: t('settings.remoteHostsInstallOrUpdateCliTitle'),
                                icon: 'cloud-download-outline',
                                inlineTestID: 'settings.remoteHosts.action.installOrUpdateCli',
                                onPress: () => void startManageHostAction(host, 'installOrUpdateCli', t('settings.remoteHostsInstallOrUpdateCliTitle')),
                            },
                            {
                                id: 'daemonInstallOrUpdate',
                                title: t('settings.remoteHostsDaemonServiceInstallOrUpdateTitle'),
                                icon: 'construct-outline',
                                onPress: () => void startManageHostAction(host, 'daemonService.installOrUpdate', t('settings.remoteHostsDaemonServiceInstallOrUpdateTitle')),
                            },
                            {
                                id: 'daemonStart',
                                title: t('settings.remoteHostsDaemonServiceStartTitle'),
                                icon: 'play-outline',
                                onPress: () => void startManageHostAction(host, 'daemonService.start', t('settings.remoteHostsDaemonServiceStartTitle')),
                            },
                            {
                                id: 'daemonStop',
                                title: t('settings.remoteHostsDaemonServiceStopTitle'),
                                icon: 'stop-outline',
                                onPress: () => void startManageHostAction(host, 'daemonService.stop', t('settings.remoteHostsDaemonServiceStopTitle')),
                            },
                            {
                                id: 'daemonRestart',
                                title: t('settings.remoteHostsDaemonServiceRestartTitle'),
                                icon: 'refresh-outline',
                                onPress: () => void startManageHostAction(host, 'daemonService.restart', t('settings.remoteHostsDaemonServiceRestartTitle')),
                            },
                            {
                                id: 'relayRuntimeStatus',
                                title: t('settings.remoteHostsRelayRuntimeStatusTitle'),
                                icon: 'information-circle-outline',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.status', t('settings.remoteHostsRelayRuntimeStatusTitle')),
                            },
                            {
                                id: 'relayRuntimeInstallOrUpdate',
                                title: t('settings.remoteHostsRelayRuntimeInstallOrUpdateTitle'),
                                icon: 'download-outline',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.installOrUpdate', t('settings.remoteHostsRelayRuntimeInstallOrUpdateTitle')),
                            },
                            {
                                id: 'relayRuntimeStart',
                                title: t('settings.remoteHostsRelayRuntimeStartTitle'),
                                icon: 'play-outline',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.start', t('settings.remoteHostsRelayRuntimeStartTitle')),
                            },
                            {
                                id: 'relayRuntimeStop',
                                title: t('settings.remoteHostsRelayRuntimeStopTitle'),
                                icon: 'stop-outline',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.stop', t('settings.remoteHostsRelayRuntimeStopTitle')),
                            },
                            {
                                id: 'relayRuntimeRestart',
                                title: t('settings.remoteHostsRelayRuntimeRestartTitle'),
                                icon: 'refresh-outline',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.restart', t('settings.remoteHostsRelayRuntimeRestartTitle')),
                            },
                            {
                                id: 'edit',
                                title: t('common.edit'),
                                icon: 'pencil-outline',
                                inlineTestID: `settings.remoteHosts.action.edit.${host.id}`,
                                onPress: () => openEditor(host.id),
                            },
                            {
                                id: 'remove',
                                title: t('common.remove'),
                                icon: 'trash-outline',
                                destructive: true,
                                onPress: () => {
                                    void (async () => {
                                        const confirmed = await Modal.confirm(
                                            t('common.remove'),
                                            host.name,
                                            { destructive: true, confirmText: t('common.remove'), cancelText: t('common.cancel') },
                                        );
                                        if (!confirmed) return;
                                        props.setRemoteHosts(removeRemoteHost(props.remoteHosts ?? [], host.id));
                                        deleteRemoteHostLocalOverrides(host.id);
                                    })();
                                },
                            },
                        ];

                        const subtitle = [
                            host.ssh.target,
                            typeof host.ssh.port === 'number' && Number.isFinite(host.ssh.port)
                                ? t('settings.remoteHostsPortLine', { port: host.ssh.port })
                                : null,
                        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n');

                        return (
                            <Item
                                key={host.id}
                                testID={`settings.remoteHosts.hostRow.${host.id}`}
                                title={host.name}
                                subtitle={subtitle}
                                subtitleLines={0}
                                icon={<Ionicons name="desktop-outline" size={18} color={props.themeTextSecondary} />}
                                showChevron={false}
                                onPress={props.supportsWholeRowPress ? () => openEditor(host.id) : undefined}
                                rightElement={(
                                    <ItemRowActions
                                        title={host.name}
                                        actions={actions}
                                        compactActionIds={['testConnection']}
                                        pinnedActionIds={['testConnection']}
                                        overflowPosition="beforePinned"
                                    />
                                )}
                            />
                        );
                    })()
                ))}
            </ItemGroup>

            <ItemGroup title={t('common.actions')}>
                <Item
                    testID="settings.remoteHosts.addHost"
                    title={t('settings.remoteHostsAddHost')}
                    onPress={() => openEditor(null)}
                />
            </ItemGroup>

            {activeTaskSnapshot ? (
                <ItemGroup title={t('settings.remoteHostsActiveTaskTitle')}>
                    <SystemTaskProgressCard
                        snapshot={activeTaskSnapshot}
                        onCancel={activeTaskSnapshot.result ? undefined : () => {
                            if (!activeTaskId) return;
                            void runner.cancel(activeTaskId);
                        }}
                        title={activeTaskTitle ?? t('settings.remoteHostsActiveTaskTitle')}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

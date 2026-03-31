import * as React from 'react';
import { Animated, Platform, View } from 'react-native';

import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import type { AttachmentFilePickerHandle, PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { SystemTaskProgressCard } from '@/components/systemTasks';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

import { DesktopOnlySetupNotice } from './DesktopOnlySetupNotice';
import { SshCredentialsFields } from './shared/SshCredentialsFields';
import { useRemoteSshBootstrapTask, type RemoteSshBootstrapPrompt } from './useRemoteSshBootstrapTask';

function buildPromptDescription(prompt: RemoteSshBootstrapPrompt): string {
    if (prompt.kind === 'auth.approveRemoteProvisioning') {
        return prompt.publicKey ?? '';
    }
    if (prompt.kind === 'ssh.password') {
        return prompt.target;
    }

    return [
        prompt.host,
        prompt.keyType,
        prompt.fingerprint,
        prompt.kind === 'ssh.replaceHostKey' ? prompt.existingFingerprint : null,
    ].filter(Boolean).join('\n');
}

function resolvePromptPrimaryActionLabel(prompt: RemoteSshBootstrapPrompt): string {
    if (prompt.kind === 'ssh.password') {
        return t('common.continue');
    }
    if (prompt.kind === 'auth.approveRemoteProvisioning') {
        return t('settings.machineSetupRemotePromptApproveAction');
    }
    if (prompt.kind === 'ssh.replaceHostKey') {
        return t('settings.machineSetupRemotePromptReplaceAction');
    }
    return t('settings.machineSetupRemotePromptTrustAction');
}

function normalizeFileUriToPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith('file://')) {
        return trimmed;
    }

    let pathname = trimmed.slice('file://'.length);
    if (pathname.startsWith('localhost')) {
        pathname = pathname.slice('localhost'.length);
    }

    try {
        pathname = decodeURIComponent(pathname);
    } catch {
        // keep raw pathname
    }

    if (/^\/[a-zA-Z]:\//.test(pathname)) {
        return pathname.slice(1);
    }

    return pathname;
}

function resolvePickedIdentityFilePath(picked: PickedAttachment): string | null {
    if (picked.kind !== 'native') {
        return null;
    }

    const uri = typeof picked.uri === 'string' ? picked.uri.trim() : '';
    if (!uri) {
        return null;
    }
    if (uri.startsWith('file://')) {
        return normalizeFileUriToPath(uri);
    }
    if (uri.includes('://')) {
        return null;
    }
    return uri;
}

function readCompletedRelayRuntime(snapshot: ReturnType<typeof useRemoteSshBootstrapTask>['activeTaskSnapshot']): Readonly<{
    relayUrl: string;
}> | null {
    if (!snapshot?.result?.ok) {
        return null;
    }

    const relayRuntime = (snapshot.result.data as {
        relayRuntime?: {
            relayUrl?: unknown;
            mode?: unknown;
        };
    } | undefined)?.relayRuntime;
    const relayUrl = typeof relayRuntime?.relayUrl === 'string' ? relayRuntime.relayUrl.trim() : '';
    if (!relayUrl) {
        return null;
    }

    return {
        relayUrl,
    };
}

function resolveStartFailureMessage(error: unknown): string {
    if (isSystemTaskBridgeUnavailableError(error)) {
        return t('settings.systemTaskBridgeUnavailable');
    }
    return readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed');
}

export const RemoteSshMachineSetupSection = React.memo(function RemoteSshMachineSetupSection(props: Readonly<{
    expanded: boolean;
    initialInstallRelayRuntime?: boolean;
    runner?: SystemTaskRunner;
    onCompletedChange?: (payload: Readonly<{ machineId: string | null; serverId: string | null; relayRuntimeUrl: string | null }>) => void;
}>) {
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop();
    const supportsDesktopControls = !isBrowserWeb && (props.runner != null || isTauriDesktop());
    const isDesktop = isTauriDesktop();
    if (!supportsDesktopControls) {
        return (
            <DesktopOnlySetupNotice
                testID="settings.machineSetup.desktopOnlyNotice"
                groupTitle={t('settings.machineSetupStagesTitle')}
                title={t('settings.machineSetupSshMachineTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
        );
    }
    const activeServerSnapshot = getActiveServerSnapshot();
    const identityFilePickerRef = React.useRef<AttachmentFilePickerHandle | null>(null);
    const activeLocalRelayUrl = typeof activeServerSnapshot.activeLocalRelayUrl === 'string'
        && activeServerSnapshot.activeLocalRelayUrl.trim().length > 0
        ? activeServerSnapshot.activeLocalRelayUrl.trim()
        : null;
    const [sshUsername, setSshUsername] = React.useState('');
    const [sshHost, setSshHost] = React.useState('');
    const [sshPort, setSshPort] = React.useState('');
    const [sshAuth, setSshAuth] = React.useState<'agent' | 'keyfile' | 'password'>('agent');
    const [identityFilePath, setIdentityFilePath] = React.useState('');
    const [sshPassword, setSshPassword] = React.useState('');
    const [installRelayRuntime, setInstallRelayRuntime] = React.useState(() => Boolean(props.initialInstallRelayRuntime));
    const {
        activeTaskSnapshot,
        answerPasswordPrompt,
        cancel,
        completedMachineId,
        continueAfterPrompt,
        dismissPrompt,
        isStarting,
        prompt,
        resetPromptResolution,
        start,
    } = useRemoteSshBootstrapTask({
        ...(props.runner ? { runner: props.runner } : {}),
        relayUrl: activeLocalRelayUrl ?? activeServerSnapshot.serverUrl,
        webappUrl: activeServerSnapshot.serverUrl,
        ...(activeLocalRelayUrl ? { publicRelayUrl: activeServerSnapshot.serverUrl } : {}),
    });
    const completedRelayRuntime = React.useMemo(() => readCompletedRelayRuntime(activeTaskSnapshot), [activeTaskSnapshot]);

    React.useEffect(() => {
        props.onCompletedChange?.({
            machineId: completedMachineId,
            serverId: completedMachineId ? activeServerSnapshot.serverId : null,
            relayRuntimeUrl: completedRelayRuntime?.relayUrl ?? null,
        });
    }, [activeServerSnapshot.serverId, completedMachineId, completedRelayRuntime?.relayUrl, props]);

    const clearPromptStateForManualChange = React.useCallback(() => {
        resetPromptResolution();
        if (prompt) {
            dismissPrompt();
        }
    }, [dismissPrompt, prompt, resetPromptResolution]);

    const updateSshUsername = React.useCallback((value: string) => {
        setSshUsername(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const updateSshHost = React.useCallback((value: string) => {
        setSshHost(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const updateSshPort = React.useCallback((value: string) => {
        setSshPort(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const updateIdentityFilePath = React.useCallback((value: string) => {
        setIdentityFilePath(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const updateSshPassword = React.useCallback((value: string) => {
        setSshPassword(value);
    }, []);

    const handleIdentityFilePicked = React.useCallback((attachments: readonly PickedAttachment[]) => {
        const pickedPath = attachments
            .map(resolvePickedIdentityFilePath)
            .find((path): path is string => typeof path === 'string' && path.length > 0) ?? '';
        if (!pickedPath) {
            return;
        }
        updateIdentityFilePath(pickedPath);
    }, [updateIdentityFilePath]);

    const updateAuthMode = React.useCallback((value: 'agent' | 'keyfile' | 'password') => {
        setSshAuth(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const chooseIdentityFilePathFromDesktop = React.useCallback(async () => {
        try {
            const picked = await invokeTauri<string | null>('desktop_pick_ssh_identity_file');
            const nextPath = typeof picked === 'string' ? picked.trim() : '';
            if (!nextPath) {
                return;
            }
            updateIdentityFilePath(nextPath.startsWith('file://') ? normalizeFileUriToPath(nextPath) : nextPath);
        } catch (error) {
            Modal.alert(t('common.error'), resolveStartFailureMessage(error));
        }
    }, [updateIdentityFilePath]);

    const handleStart = React.useCallback(async () => {
        try {
            await start({
                sshUsername,
                sshHost,
                sshPort,
                sshAuth,
                sshPassword,
                identityFilePath,
                installRelayRuntime,
            });
        } catch (error) {
            Modal.alert(t('common.error'), resolveStartFailureMessage(error));
        }
    }, [identityFilePath, installRelayRuntime, sshAuth, sshHost, sshPassword, sshPort, sshUsername, start]);

    const handleContinueAfterPrompt = React.useCallback(async () => {
        try {
            if (prompt?.kind === 'ssh.password') {
                await answerPasswordPrompt({
                    sshUsername,
                    sshHost,
                    sshPort,
                    sshAuth,
                    sshPassword,
                    identityFilePath,
                    installRelayRuntime,
                });
                return;
            }
            await continueAfterPrompt({
                sshUsername,
                sshHost,
                sshPort,
                sshAuth,
                sshPassword,
                identityFilePath,
                installRelayRuntime,
            });
        } catch (error) {
            Modal.alert(t('common.error'), resolveStartFailureMessage(error));
        }
    }, [answerPasswordPrompt, continueAfterPrompt, identityFilePath, installRelayRuntime, prompt?.kind, sshAuth, sshHost, sshPassword, sshPort, sshUsername]);

    const formDisabled = isStarting || (activeTaskSnapshot != null && activeTaskSnapshot.result == null);
    const startDisabled = formDisabled
        || !sshHost.trim()
        || (sshAuth === 'keyfile' && !identityFilePath.trim())
        || (sshAuth === 'password' && !sshPassword.trim());
    const shouldBeVisible = props.expanded || activeTaskSnapshot != null || prompt != null || completedRelayRuntime != null;
    const [shouldRender, setShouldRender] = React.useState<boolean>(shouldBeVisible);
    const progress = React.useRef(new Animated.Value(shouldBeVisible ? 1 : 0)).current;
    const didMountRef = React.useRef(false);

    React.useEffect(() => {
        if (!didMountRef.current) {
            didMountRef.current = true;
            return;
        }

        if (shouldBeVisible) {
            setShouldRender(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: motionTokens.durationMs.base,
                easing: motionTokens.easing.standard,
                useNativeDriver: false,
            }).start();
            return;
        }

        Animated.timing(progress, {
            toValue: 0,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        }).start(({ finished }) => {
            if (finished) setShouldRender(false);
        });
    }, [progress, shouldBeVisible]);

    if (!shouldRender) {
        return null;
    }

    const maxHeight = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 10_000] });
    const opacity = progress.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.7, 1] });
    const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-2, 0] });

    return (
        <Animated.View
            style={{
                overflow: 'hidden',
                maxHeight,
                opacity,
                transform: [{ translateY }],
            }}
            pointerEvents={shouldBeVisible ? 'auto' : 'none'}
        >
            {sshAuth === 'keyfile' && Platform.OS !== 'web' ? (
                <AttachmentFilePicker
                    ref={identityFilePickerRef}
                    multiple={false}
                    onAttachmentsPicked={handleIdentityFilePicked}
                />
            ) : null}

            <SshCredentialsFields
                testIDPrefix="settings.machineSetup.remoteSsh"
                testIDs={{
                    sshUsername: 'settings.machineSetup.remoteSshUsernameInput',
                    sshHost: 'settings.machineSetup.remoteSshHostInput',
                    sshPort: 'settings.machineSetup.remoteSshPortInput',
                    sshAuthAgent: 'settings.machineSetup.remoteAuth.agent',
                    sshAuthKeyfile: 'settings.machineSetup.remoteAuth.keyfile',
                    sshAuthPassword: 'settings.machineSetup.remoteAuth.password',
                    sshIdentityFile: 'settings.machineSetup.remoteIdentityFileInput',
                    sshPassword: 'settings.machineSetup.remotePasswordInput',
                    chooseIdentityFile: 'settings.machineSetup.remoteChooseIdentityFile',
                }}
                disabled={formDisabled}
                value={{
                    username: sshUsername,
                    host: sshHost,
                    port: sshPort,
                    authMode: sshAuth,
                    identityFilePath,
                    password: sshPassword,
                }}
                onChange={(next) => {
                    if (next.username !== sshUsername) {
                        updateSshUsername(next.username);
                    }
                    if (next.host !== sshHost) {
                        updateSshHost(next.host);
                    }
                    if (next.port !== sshPort) {
                        updateSshPort(next.port);
                    }
                    if (next.authMode !== sshAuth) {
                        updateAuthMode(next.authMode);
                    }
                    if (next.identityFilePath !== identityFilePath) {
                        updateIdentityFilePath(next.identityFilePath);
                    }
                    if (next.password !== sshPassword) {
                        updateSshPassword(next.password);
                    }
                }}
                onChooseIdentityFile={
                    sshAuth !== 'keyfile'
                        ? undefined
                        : Platform.OS !== 'web'
                            ? () => identityFilePickerRef.current?.openFiles()
                            : isDesktop
                                ? () => {
                                    void chooseIdentityFilePathFromDesktop();
                                }
                                : undefined
                }
                afterAuthGroups={(
                    <ItemGroup>
                        <Item
                            testID="settings.machineSetup.remoteRelayRuntime"
                            title={t('settings.machineSetupRemoteRelayRuntimeLabel')}
                            selected={installRelayRuntime}
                            onPress={() => {
                                clearPromptStateForManualChange();
                                setInstallRelayRuntime((current) => !current);
                            }}
                        />
                    </ItemGroup>
                )}
            />

            <ItemGroup>
                <Item
                    testID="settings.machineSetup.remoteStart"
                    title={t('common.start')}
                    disabled={startDisabled}
                    onPress={() => {
                        void handleStart();
                    }}
                />
            </ItemGroup>

            {activeTaskSnapshot ? (
                <View testID="settings.machineSetup.remoteProgressCard">
                    <SystemTaskProgressCard
                        title={t('settings.machineSetupSshMachineTitle')}
                        snapshot={activeTaskSnapshot}
                        onCancel={activeTaskSnapshot.result ? undefined : cancel}
                    />
                </View>
            ) : null}

            {prompt?.kind === 'ssh.password' ? (
                <ItemGroup>
                    <Item
                        testID="settings.machineSetup.remotePasswordPromptCard"
                        title={prompt.message}
                        subtitle={buildPromptDescription(prompt)}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID="settings.machineSetup.remotePasswordPromptCard-primary"
                        title={resolvePromptPrimaryActionLabel(prompt)}
                        disabled={!sshPassword.trim()}
                        onPress={() => {
                            void handleContinueAfterPrompt();
                        }}
                    />
                    <Item
                        testID="settings.machineSetup.remotePasswordPromptCard-secondary"
                        title={t('common.cancel')}
                        destructive
                        onPress={dismissPrompt}
                    />
                </ItemGroup>
            ) : prompt ? (
                <ItemGroup>
                    <Item
                        testID="settings.machineSetup.remotePromptCard"
                        title={prompt.message}
                        subtitle={buildPromptDescription(prompt)}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID="settings.machineSetup.remotePromptCard-primary"
                        title={resolvePromptPrimaryActionLabel(prompt)}
                        onPress={() => {
                            void handleContinueAfterPrompt();
                        }}
                    />
                    <Item
                        testID="settings.machineSetup.remotePromptCard-secondary"
                        title={t('common.cancel')}
                        destructive
                        onPress={dismissPrompt}
                    />
                </ItemGroup>
            ) : null}

            {completedRelayRuntime ? (
                <ItemGroup title={t('settings.machineSetupRemoteRelayRuntimeTitle')}>
                    <Item
                        testID="settings.machineSetup.remoteRelayRuntimeStatus"
                        title={t('settings.machineSetupRemoteRelayRuntimeReadyTitle')}
                        subtitle={t('settings.machineSetupRemoteRelayRuntimeReadySubtitle')}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID="settings.machineSetup.remoteRelayRuntimeUrl"
                        title={t('settings.machineSetupRemoteRelayRuntimeUrlTitle')}
                        subtitle={completedRelayRuntime.relayUrl}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}
        </Animated.View>
    );
});

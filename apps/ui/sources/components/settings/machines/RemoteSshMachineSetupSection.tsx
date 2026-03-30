import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
import { MachineSetupTextField } from './shared/MachineSetupTextField';
import { useRemoteSshBootstrapTask, type RemoteSshBootstrapPrompt } from './useRemoteSshBootstrapTask';

const stylesheet = StyleSheet.create((theme) => ({
    formContent: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 16,
    },
}));

function buildPromptDescription(prompt: RemoteSshBootstrapPrompt): string {
    if (prompt.kind === 'auth.approveRemoteProvisioning') {
        return prompt.publicKey ?? '';
    }

    return [
        prompt.host,
        prompt.keyType,
        prompt.fingerprint,
        prompt.kind === 'ssh.replaceHostKey' ? prompt.existingFingerprint : null,
    ].filter(Boolean).join('\n');
}

function resolvePromptPrimaryActionLabel(prompt: RemoteSshBootstrapPrompt): string {
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
    runner?: SystemTaskRunner;
    onCompletedChange?: (payload: Readonly<{ machineId: string | null; serverId: string | null; relayRuntimeUrl: string | null }>) => void;
}>) {
    const styles = stylesheet;
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
    const [sshTarget, setSshTarget] = React.useState('');
    const [sshAuth, setSshAuth] = React.useState<'agent' | 'keyfile'>('agent');
    const [identityFilePath, setIdentityFilePath] = React.useState('');
    const [installRelayRuntime, setInstallRelayRuntime] = React.useState(false);
    const {
        activeTaskSnapshot,
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

    const updateSshTarget = React.useCallback((value: string) => {
        setSshTarget(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const updateIdentityFilePath = React.useCallback((value: string) => {
        setIdentityFilePath(value);
        clearPromptStateForManualChange();
    }, [clearPromptStateForManualChange]);

    const handleIdentityFilePicked = React.useCallback((attachments: readonly PickedAttachment[]) => {
        const pickedPath = attachments
            .map(resolvePickedIdentityFilePath)
            .find((path): path is string => typeof path === 'string' && path.length > 0) ?? '';
        if (!pickedPath) {
            return;
        }
        updateIdentityFilePath(pickedPath);
    }, [updateIdentityFilePath]);

    const updateAuthMode = React.useCallback((value: 'agent' | 'keyfile') => {
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
                sshTarget,
                sshAuth,
                identityFilePath,
                installRelayRuntime,
            });
        } catch (error) {
            Modal.alert(t('common.error'), resolveStartFailureMessage(error));
        }
    }, [identityFilePath, installRelayRuntime, sshAuth, sshTarget, start]);

    const handleContinueAfterPrompt = React.useCallback(async () => {
        try {
            await continueAfterPrompt({
                sshTarget,
                sshAuth,
                identityFilePath,
                installRelayRuntime,
            });
        } catch (error) {
            Modal.alert(t('common.error'), resolveStartFailureMessage(error));
        }
    }, [continueAfterPrompt, identityFilePath, installRelayRuntime, sshAuth, sshTarget]);

    const formDisabled = isStarting || (activeTaskSnapshot != null && activeTaskSnapshot.result == null);
    const startDisabled = formDisabled || !sshTarget.trim() || (sshAuth === 'keyfile' && !identityFilePath.trim());
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
            <ItemGroup>
                <View style={styles.formContent}>
                    <MachineSetupTextField
                        testID="settings.machineSetup.remoteSshTargetInput"
                        label={t('settings.machineSetupRemoteSshTargetLabel')}
                        value={sshTarget}
                        editable={!formDisabled}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onChangeText={updateSshTarget}
                    />
                </View>
            </ItemGroup>

            <ItemGroup>
                <Item
                    testID="settings.machineSetup.remoteAuth.agent"
                    title={t('settings.machineSetupRemoteSshAgentAuthLabel')}
                    selected={sshAuth === 'agent'}
                    onPress={() => updateAuthMode('agent')}
                />
                <Item
                    testID="settings.machineSetup.remoteAuth.keyfile"
                    title={t('settings.machineSetupRemoteSshKeyFileAuthLabel')}
                    selected={sshAuth === 'keyfile'}
                    onPress={() => updateAuthMode('keyfile')}
                />
            </ItemGroup>

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

            {sshAuth === 'keyfile' ? (
                <>
                    {Platform.OS !== 'web' ? (
                        <AttachmentFilePicker
                            ref={identityFilePickerRef}
                            multiple={false}
                            onAttachmentsPicked={handleIdentityFilePicked}
                        />
                    ) : null}

                    <ItemGroup>
                        <View style={styles.formContent}>
                            <MachineSetupTextField
                                testID="settings.machineSetup.remoteIdentityFileInput"
                                label={t('settings.machineSetupRemoteSshIdentityFileLabel')}
                                value={identityFilePath}
                                editable={!formDisabled}
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={updateIdentityFilePath}
                            />
                        </View>
                    </ItemGroup>

                    <ItemGroup>
                        {Platform.OS !== 'web' ? (
                            <Item
                                testID="settings.machineSetup.remoteChooseIdentityFile"
                                title={t('common.open')}
                                disabled={formDisabled}
                                onPress={() => {
                                    identityFilePickerRef.current?.openFiles();
                                }}
                            />
                        ) : isDesktop ? (
                            <Item
                                testID="settings.machineSetup.remoteChooseIdentityFile"
                                title={t('common.open')}
                                disabled={formDisabled}
                                onPress={() => {
                                    void chooseIdentityFilePathFromDesktop();
                                }}
                            />
                        ) : null}
                    </ItemGroup>
                </>
            ) : null}

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

            {prompt ? (
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

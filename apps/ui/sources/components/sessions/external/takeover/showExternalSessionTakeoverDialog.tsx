import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

import { resolveExternalSessionTakeoverTargetDirectory } from './resolveExternalSessionTakeoverTargetDirectory';

export type ExternalSessionTakeoverDialogAction =
    | 'direct'
    | 'persisted'
    | 'recheck';

export type ExternalSessionTakeoverDialogResult = Readonly<{
    action: ExternalSessionTakeoverDialogAction | null;
    targetDirectory?: string;
}>;

type ExternalSessionTakeoverTarget = Readonly<{
    machineId: string;
    machineHomeDir: string;
    initialDirectory: string;
    machinePlatform?: string | null;
    serverId?: string | null;
}>;

type ExternalSessionTakeoverDialogProps = CustomModalInjectedProps & Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    runningProcessPid?: number | null;
    target?: ExternalSessionTakeoverTarget;
    onResolve: (result: ExternalSessionTakeoverDialogResult) => void;
    onRequestClose?: () => void;
}>;

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    optionButton: {
        minHeight: minimumInteractiveTargetSize,
        paddingVertical: 13,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    optionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.primary,
    },
    optionSubtitle: {
        marginTop: 4,
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    processWarningCard: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 8,
    },
    processWarningTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    processWarningBody: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    targetCard: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 8,
    },
    targetMachine: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    targetPath: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    cancelButton: {
        alignSelf: 'flex-start',
        minHeight: minimumInteractiveTargetSize,
        justifyContent: 'center',
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    cancelText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.link,
    },
}));

export function ExternalSessionTakeoverDialog(props: ExternalSessionTakeoverDialogProps) {
    useUnistyles();
    const styles = stylesheet;
    const runningProcessActive = props.runningProcessPid !== undefined;
    const [targetDirectory, setTargetDirectory] = React.useState(
        () => props.target?.initialDirectory ?? '',
    );
    const [favoriteDirectories, setFavoriteDirectories] = React.useState<ReadonlyArray<string>>([]);

    const resolve = React.useCallback((result: ExternalSessionTakeoverDialogResult) => {
        props.onResolve(result);
        props.onClose();
    }, [props.onClose, props.onResolve]);
    const normalizedTargetDirectory = React.useMemo(() => {
        return resolveExternalSessionTakeoverTargetDirectory(
            targetDirectory,
            props.target?.machineHomeDir,
        );
    }, [props.target?.machineHomeDir, targetDirectory]);
    const displayedTargetDirectory = normalizedTargetDirectory ?? targetDirectory;

    const resolveTakeover = React.useCallback((action: Extract<
        ExternalSessionTakeoverDialogAction,
        'direct' | 'persisted'
    >) => {
        if (!normalizedTargetDirectory) return;
        resolve({ action, targetDirectory: normalizedTargetDirectory });
    }, [normalizedTargetDirectory, resolve]);

    return (
        <View style={styles.body}>
            {runningProcessActive ? (
                <View style={styles.processWarningCard}>
                    <Text style={styles.processWarningTitle}>
                        {t('chatFooter.externalSessionProcessRunning')}
                    </Text>
                    <Text style={styles.processWarningBody}>
                        {t('chatFooter.externalSessionTakeoverBlocked')}
                        {props.runningProcessPid === null
                            ? null
                            : ` ${t('runs.detail.pid', {
                                pid: props.runningProcessPid,
                            })}`}
                    </Text>
                </View>
            ) : null}

            {(props.canTakeOverDirect || props.canTakeOverPersist) && props.target ? (
                <View style={styles.targetCard} testID="direct-session-takeover-dialog-target">
                    <Text style={styles.targetMachine}>
                        {t('settings.mcpServersBindingTargetMachine', {
                            machine: props.target.machineId,
                        })}
                    </Text>
                    {displayedTargetDirectory ? (
                        <Text
                            testID="direct-session-takeover-dialog-target-path"
                            style={styles.targetPath}
                            accessibilityLabel={displayedTargetDirectory}
                        >
                            {displayedTargetDirectory}
                        </Text>
                    ) : null}
                    <NewSessionPathSelectionContent
                        machineHomeDir={props.target.machineHomeDir}
                        selectedPath={targetDirectory}
                        initialSuggestionMode="browse"
                        onChangeSelectedPath={setTargetDirectory}
                        onChangeDraftSelectedPath={setTargetDirectory}
                        onSubmitSelectedPath={setTargetDirectory}
                        submitBehavior="showRow"
                        recentPaths={[]}
                        usePickerSearch={false}
                        searchQuery=""
                        onChangeSearchQuery={() => {}}
                        favoriteDirectories={favoriteDirectories}
                        onChangeFavoriteDirectories={setFavoriteDirectories}
                        machineBrowse={{
                            enabled: true,
                            machineId: props.target.machineId,
                            ...(props.target.serverId ? { serverId: props.target.serverId } : {}),
                        }}
                        machinePlatform={props.target.machinePlatform}
                        maxHeight={260}
                    />
                </View>
            ) : null}

            {props.canTakeOverDirect ? (
                <Pressable
                    testID="direct-session-takeover-dialog-direct"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.directTakeoverDialogDirectTitle')}
                    accessibilityHint={t('chatFooter.directTakeoverDialogDirectBody')}
                    accessibilityState={{ disabled: !normalizedTargetDirectory }}
                    disabled={!normalizedTargetDirectory}
                    onPress={() => resolveTakeover('direct')}
                    style={({ pressed }) => [styles.optionButton, { opacity: pressed ? 0.85 : 1 }]}
                >
                    <Text style={styles.optionTitle}>{t('chatFooter.directTakeoverDialogDirectTitle')}</Text>
                    <Text style={styles.optionSubtitle}>{t('chatFooter.directTakeoverDialogDirectBody')}</Text>
                </Pressable>
            ) : null}

            {props.canTakeOverPersist ? (
                <Pressable
                    testID="direct-session-takeover-dialog-persist"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.directTakeoverDialogPersistTitle')}
                    accessibilityHint={t('chatFooter.directTakeoverDialogPersistBody')}
                    accessibilityState={{ disabled: !normalizedTargetDirectory }}
                    disabled={!normalizedTargetDirectory}
                    onPress={() => resolveTakeover('persisted')}
                    style={({ pressed }) => [styles.optionButton, { opacity: pressed ? 0.85 : 1 }]}
                >
                    <Text style={styles.optionTitle}>{t('chatFooter.directTakeoverDialogPersistTitle')}</Text>
                    <Text style={styles.optionSubtitle}>{t('chatFooter.directTakeoverDialogPersistBody')}</Text>
                </Pressable>
            ) : null}

            {runningProcessActive ? (
                <Pressable
                    testID="direct-session-takeover-dialog-recheck"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.externalSessionRecheck')}
                    accessibilityHint={t('chatFooter.externalSessionTakeoverBlocked')}
                    onPress={() => resolve({ action: 'recheck' })}
                    style={({ pressed }) => [
                        styles.optionButton,
                        { opacity: pressed ? 0.85 : 1 },
                    ]}
                >
                    <Text style={styles.optionTitle}>
                        {t('chatFooter.externalSessionRecheck')}
                    </Text>
                </Pressable>
            ) : null}

            <Pressable
                testID="direct-session-takeover-dialog-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                onPress={() => resolve({ action: null })}
                style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? 0.7 : 1 }]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
        </View>
    );
}

export async function showExternalSessionTakeoverDialog(params: Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    runningProcessPid?: number | null;
    target?: ExternalSessionTakeoverTarget;
}>): Promise<ExternalSessionTakeoverDialogResult> {
    const deferred = createDeferredOnce<ExternalSessionTakeoverDialogResult>();
    Modal.show({
        component: ExternalSessionTakeoverDialog,
        props: {
            canTakeOverDirect: params.canTakeOverDirect,
            canTakeOverPersist: params.canTakeOverPersist,
            ...(params.runningProcessPid !== undefined
                ? { runningProcessPid: params.runningProcessPid }
                : {}),
            ...(params.target ? { target: params.target } : {}),
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve({ action: null }),
        chrome: {
            kind: 'card',
            title: t('chatFooter.directTakeoverDialogTitle'),
            subtitle: t('chatFooter.directTakeoverDialogBody'),
            testID: 'direct-session-takeover-dialog',
            bodyScroll: 'auto',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}

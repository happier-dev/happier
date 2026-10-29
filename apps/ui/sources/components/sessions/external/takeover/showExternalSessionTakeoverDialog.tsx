import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

import { resolveExternalSessionTakeoverTargetDirectory } from './resolveExternalSessionTakeoverTargetDirectory';
import { motionTokens } from '@/components/ui/motion/motionTokens';

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

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        gap: theme.space.s12,
    },
    optionButton: {
        paddingVertical: theme.space.s12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    optionTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    optionSubtitle: {
        marginTop: theme.space.s4,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    processWarningCard: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s12,
        gap: theme.space.s8,
    },
    processWarningTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    processWarningBody: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    targetCard: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s12,
        gap: theme.space.s8,
    },
    targetMachine: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    targetPath: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    cancelButton: {
        alignSelf: 'flex-start',
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s4,
    },
    cancelText: {
        ...Typography.variant('label', 'semiBold'),
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
                <HappierPressable
                    testID="direct-session-takeover-dialog-direct"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.directTakeoverDialogDirectTitle')}
                    accessibilityHint={t('chatFooter.directTakeoverDialogDirectBody')}
                    disabled={!normalizedTargetDirectory}
                    onPress={() => resolveTakeover('direct')}
                    style={({ pressed }) => [styles.optionButton, { opacity: pressed ? motionTokens.press.opacitySubtle : 1 }]}
                >
                    <Text style={styles.optionTitle}>{t('chatFooter.directTakeoverDialogDirectTitle')}</Text>
                    <Text style={styles.optionSubtitle}>{t('chatFooter.directTakeoverDialogDirectBody')}</Text>
                </HappierPressable>
            ) : null}

            {props.canTakeOverPersist ? (
                <HappierPressable
                    testID="direct-session-takeover-dialog-persist"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.directTakeoverDialogPersistTitle')}
                    accessibilityHint={t('chatFooter.directTakeoverDialogPersistBody')}
                    disabled={!normalizedTargetDirectory}
                    onPress={() => resolveTakeover('persisted')}
                    style={({ pressed }) => [styles.optionButton, { opacity: pressed ? motionTokens.press.opacitySubtle : 1 }]}
                >
                    <Text style={styles.optionTitle}>{t('chatFooter.directTakeoverDialogPersistTitle')}</Text>
                    <Text style={styles.optionSubtitle}>{t('chatFooter.directTakeoverDialogPersistBody')}</Text>
                </HappierPressable>
            ) : null}

            {runningProcessActive ? (
                <HappierPressable
                    testID="direct-session-takeover-dialog-recheck"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.externalSessionRecheck')}
                    accessibilityHint={t('chatFooter.externalSessionTakeoverBlocked')}
                    onPress={() => resolve({ action: 'recheck' })}
                    style={({ pressed }) => [
                        styles.optionButton,
                        { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
                    ]}
                >
                    <Text style={styles.optionTitle}>
                        {t('chatFooter.externalSessionRecheck')}
                    </Text>
                </HappierPressable>
            ) : null}

            <HappierPressable
                testID="direct-session-takeover-dialog-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                onPress={() => resolve({ action: null })}
                style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? motionTokens.press.opacity : 1 }]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </HappierPressable>
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
            dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}

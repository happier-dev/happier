import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { t } from '@/text';

import type { PendingPluginChangeReview } from './model/pluginMarketplaceModel';

type OptionalHostAccess = PendingPluginChangeReview['review']['optionalHostAccess'][number];

export type PluginInstallationReviewResolution =
    | Readonly<{
        approved: true;
        optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
    }>
    | Readonly<{
        approved: false;
        optionalSelections: readonly [];
    }>;

type PluginInstallationReviewDialogProps = CustomModalInjectedProps & Readonly<{
    body: string;
    optionalHostAccess: readonly OptionalHostAccess[];
    onResolve: (resolution: PluginInstallationReviewResolution) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flexGrow: 1,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 20,
        gap: 16,
    },
    reviewBody: {
        ...Typography.default(),
        color: theme.colors.text.primary,
    },
    optionalList: {
        gap: 8,
    },
    optionalRow: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    optionalCopy: {
        flex: 1,
        gap: 2,
    },
    optionalTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    optionalReason: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    switch: {
        minWidth: 44,
        minHeight: 44,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
    action: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 16,
        borderRadius: 12,
    },
    actionFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
    cancelAction: {
        backgroundColor: theme.colors.surface.inset,
    },
    confirmAction: {
        backgroundColor: theme.colors.button.primary.background,
    },
    cancelText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    confirmText: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.primary.tint,
    },
}));

export function PluginInstallationReviewDialog(props: PluginInstallationReviewDialogProps) {
    useUnistyles();
    const styles = stylesheet;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const [selectedByAccessId, setSelectedByAccessId] = React.useState<Readonly<Record<string, boolean>>>({});

    const resolve = React.useCallback((resolution: PluginInstallationReviewResolution) => {
        props.onResolve(resolution);
        props.onClose();
    }, [props]);

    const approve = React.useCallback(() => {
        resolve({
            approved: true,
            optionalSelections: props.optionalHostAccess.map((entry) => ({
                accessId: entry.id,
                selected: selectedByAccessId[entry.id] === true,
            })),
        });
    }, [props.optionalHostAccess, resolve, selectedByAccessId]);

    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
        >
            <Text style={styles.reviewBody}>{props.body}</Text>
            {props.optionalHostAccess.length > 0 ? (
                <View style={styles.optionalList}>
                    {props.optionalHostAccess.map((entry) => {
                        const selected = selectedByAccessId[entry.id] === true;
                        const accessibilityLabel = `${entry.capability}: ${entry.reason}`;
                        return (
                            <View key={entry.id} style={styles.optionalRow}>
                                <View style={styles.optionalCopy}>
                                    <Text style={styles.optionalTitle}>{entry.capability}</Text>
                                    <Text style={styles.optionalReason}>{entry.reason}</Text>
                                </View>
                                <Switch
                                    testID={`settings.plugins.installReview.optional.${entry.id}`}
                                    accessibilityRole="switch"
                                    accessibilityLabel={accessibilityLabel}
                                    accessibilityState={{ checked: selected }}
                                    style={[styles.switch, { minWidth: minimumInteractiveTargetSize, minHeight: minimumInteractiveTargetSize }]}
                                    value={selected}
                                    onValueChange={(next) => {
                                        setSelectedByAccessId((current) => ({
                                            ...current,
                                            [entry.id]: next,
                                        }));
                                    }}
                                />
                            </View>
                        );
                    })}
                </View>
            ) : null}
            <View style={styles.actions}>
                <Pressable
                    testID="settings.plugins.installReview.cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    onPress={() => resolve({ approved: false, optionalSelections: [] })}
                    style={(interactionState) => {
                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                        return [
                            styles.action,
                            { minHeight: minimumInteractiveTargetSize },
                            styles.cancelAction,
                            { opacity: interactionState.pressed ? 0.75 : 1 },
                            webState.focused === true ? styles.actionFocused : null,
                        ];
                    }}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    testID="settings.plugins.installReview.confirm"
                    accessibilityRole="button"
                    accessibilityLabel={t('settingsPlugins.installAndTrust')}
                    onPress={approve}
                    style={(interactionState) => {
                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                        return [
                            styles.action,
                            { minHeight: minimumInteractiveTargetSize },
                            styles.confirmAction,
                            { opacity: interactionState.pressed ? 0.8 : 1 },
                            webState.focused === true ? styles.actionFocused : null,
                        ];
                    }}
                >
                    <Text style={styles.confirmText}>{t('settingsPlugins.installAndTrust')}</Text>
                </Pressable>
            </View>
        </ScrollView>
    );
}

export async function showPluginInstallationReviewDialog(params: Readonly<{
    title: string;
    body: string;
    optionalHostAccess: readonly OptionalHostAccess[];
}>): Promise<PluginInstallationReviewResolution> {
    const deferred = createDeferredOnce<PluginInstallationReviewResolution>();
    Modal.show({
        component: PluginInstallationReviewDialog,
        props: {
            body: params.body,
            optionalHostAccess: params.optionalHostAccess,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve({ approved: false, optionalSelections: [] }),
        chrome: {
            kind: 'card',
            title: params.title,
            testID: 'settings.plugins.installReview',
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 640, maxHeightRatio: 0.9, size: 'lg' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

export type PathConflictResolutionStrategy = 'keep_both' | 'replace' | 'skip' | 'cancel';

const stylesheet = StyleSheet.create((theme) => ({
    options: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 12,
        paddingTop: 14,
        paddingBottom: 14,
        gap: 10,
    },
    optionButton: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 2,
    },
    optionTitle: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    optionSubtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    optionPrimaryBorder: {
        borderColor: theme.colors.text.link,
    },
    cancelRow: {
        paddingVertical: 10,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
}));

function PathConflictOption(props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    primary?: boolean;
    onPress: () => void;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            onPress={props.onPress}
            style={({ pressed }) => ([
                styles.optionButton,
                props.primary ? styles.optionPrimaryBorder : null,
                pressed ? { opacity: 0.92 } : null,
            ])}
        >
            <Text style={styles.optionTitle}>{props.title}</Text>
            <Text style={styles.optionSubtitle}>{props.subtitle}</Text>
        </Pressable>
    );
}

type PathConflictResolutionDialogProps = CustomModalInjectedProps & Readonly<{
    allowSkip: boolean;
    primaryStrategy?: Exclude<PathConflictResolutionStrategy, 'cancel'> | null;
    testIdPrefix: string;
    onResolve: (strategy: PathConflictResolutionStrategy) => void;
}>;

const PathConflictResolutionDialog: React.FC<PathConflictResolutionDialogProps> = (props) => {
    const styles = stylesheet;
    useUnistyles();

    return (
        <View style={styles.options}>
            <PathConflictOption
                testID={`${props.testIdPrefix}-keep-both`}
                title={t('files.upload.conflicts.keepBoth.title')}
                subtitle={t('files.upload.conflicts.keepBoth.subtitle')}
                primary={props.primaryStrategy === 'keep_both'}
                onPress={() => {
                    props.onResolve('keep_both');
                    props.onClose();
                }}
            />
            <PathConflictOption
                testID={`${props.testIdPrefix}-replace`}
                title={t('files.upload.conflicts.replace.title')}
                subtitle={t('files.upload.conflicts.replace.subtitle')}
                primary={props.primaryStrategy === 'replace'}
                onPress={() => {
                    props.onResolve('replace');
                    props.onClose();
                }}
            />
            {props.allowSkip ? (
                <PathConflictOption
                    testID={`${props.testIdPrefix}-skip`}
                    title={t('files.upload.conflicts.skip.title')}
                    subtitle={t('files.upload.conflicts.skip.subtitle')}
                    primary={props.primaryStrategy === 'skip'}
                    onPress={() => {
                        props.onResolve('skip');
                        props.onClose();
                    }}
                />
            ) : null}
            <Pressable
                testID={`${props.testIdPrefix}-cancel`}
                accessibilityRole="button"
                onPress={() => {
                    props.onResolve('cancel');
                    props.onClose();
                }}
                style={({ pressed }) => [
                    styles.cancelRow,
                    pressed ? { opacity: 0.85 } : null,
                ]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
        </View>
    );
};

export async function showPathConflictResolutionDialog(params: Readonly<{
    title: string;
    body: string;
    allowSkip: boolean;
    primaryStrategy?: Exclude<PathConflictResolutionStrategy, 'cancel'> | null;
    testIdPrefix?: string;
}>): Promise<PathConflictResolutionStrategy> {
    const deferred = createDeferredOnce<PathConflictResolutionStrategy>();
    Modal.show({
        component: PathConflictResolutionDialog,
        props: {
            allowSkip: params.allowSkip,
            primaryStrategy: params.primaryStrategy ?? null,
            testIdPrefix: params.testIdPrefix ?? 'path-conflicts',
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve('cancel'),
        chrome: {
            kind: 'card',
            title: params.title,
            subtitle: params.body,
            testID: `${params.testIdPrefix ?? 'path-conflicts'}-modal`,
            bodyScroll: 'auto',
            dimensions: { width: 420, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}

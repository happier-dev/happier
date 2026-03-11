import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

export type PathConflictResolutionStrategy = 'keep_both' | 'replace' | 'skip' | 'cancel';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: 420,
        maxWidth: '92%',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    header: {
        paddingHorizontal: 18,
        paddingTop: 16,
        paddingBottom: 12,
        gap: 8,
    },
    title: {
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    options: {
        paddingHorizontal: 12,
        paddingBottom: 12,
        gap: 10,
    },
    optionButton: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 2,
    },
    optionTitle: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    optionSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    optionPrimaryBorder: {
        borderColor: theme.colors.textLink,
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

type PathConflictResolutionDialogProps = Readonly<{
    title: string;
    body: string;
    allowSkip: boolean;
    primaryStrategy?: Exclude<PathConflictResolutionStrategy, 'cancel'> | null;
    testIdPrefix: string;
    onResolve: (strategy: Exclude<PathConflictResolutionStrategy, 'cancel'>) => void;
    onClose: () => void;
}>;

const PathConflictResolutionDialog: React.FC<PathConflictResolutionDialogProps> = (props) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <Text style={styles.title}>{props.title}</Text>
                <Text style={styles.body}>{props.body}</Text>
            </View>
            <View style={styles.options}>
                <PathConflictOption
                    testID={`${props.testIdPrefix}-keep-both`}
                    title={t('files.upload.conflicts.keepBoth.title')}
                    subtitle={t('files.upload.conflicts.keepBoth.subtitle')}
                    primary={props.primaryStrategy === 'keep_both'}
                    onPress={() => props.onResolve('keep_both')}
                />
                <PathConflictOption
                    testID={`${props.testIdPrefix}-replace`}
                    title={t('files.upload.conflicts.replace.title')}
                    subtitle={t('files.upload.conflicts.replace.subtitle')}
                    primary={props.primaryStrategy === 'replace'}
                    onPress={() => props.onResolve('replace')}
                />
                {props.allowSkip ? (
                    <PathConflictOption
                        testID={`${props.testIdPrefix}-skip`}
                        title={t('files.upload.conflicts.skip.title')}
                        subtitle={t('files.upload.conflicts.skip.subtitle')}
                        primary={props.primaryStrategy === 'skip'}
                        onPress={() => props.onResolve('skip')}
                    />
                ) : null}
                <Pressable
                    testID={`${props.testIdPrefix}-cancel`}
                    accessibilityRole="button"
                    onPress={props.onClose}
                    style={({ pressed }) => ({
                        paddingVertical: 10,
                        alignItems: 'center',
                        opacity: pressed ? 0.85 : 1,
                    })}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                        {t('common.cancel')}
                    </Text>
                </Pressable>
            </View>
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
    return await new Promise<PathConflictResolutionStrategy>((resolve) => {
        let modalId = '';
        let settled = false;

        const resolveOnce = (strategy: PathConflictResolutionStrategy) => {
            if (settled) return;
            settled = true;
            resolve(strategy);
        };

        type WrapperProps = Readonly<{ onRequestClose?: () => void; onClose: () => void }>;
        const Wrapper: React.FC<WrapperProps> = ({ onClose }) => (
            <PathConflictResolutionDialog
                title={params.title}
                body={params.body}
                allowSkip={params.allowSkip}
                primaryStrategy={params.primaryStrategy ?? null}
                testIdPrefix={params.testIdPrefix ?? 'path-conflicts'}
                onResolve={(strategy) => {
                    resolveOnce(strategy);
                    if (modalId) {
                        Modal.hide(modalId);
                    }
                }}
                onClose={onClose}
            />
        );

        modalId = Modal.show({
            component: Wrapper,
            props: {
                onRequestClose: () => resolveOnce('cancel'),
            },
            closeOnBackdrop: true,
        });
    });
}

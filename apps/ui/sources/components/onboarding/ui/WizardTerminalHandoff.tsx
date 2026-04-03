import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { HANDOFF_TEXT_MAX_WIDTH } from './handoffLayout';

export type WizardTerminalHandoffStep = Readonly<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    code: string;
    windowsCode?: string;
    language?: React.ComponentProps<typeof CodeBlockView>['language'];
    windowsLanguage?: React.ComponentProps<typeof CodeBlockView>['language'];
    scrollTestIDSuffix: string;
}>;

export type WizardTerminalHandoffProps = Readonly<{
    testID: string;
    steps: readonly WizardTerminalHandoffStep[];
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 12,
        alignItems: 'center',
    },
    section: {
        width: '100%',
        gap: 4,
    },
    sectionTitle: {
        textAlign: 'center',
        color: theme.colors.text,
        fontSize: 16,
        marginTop: 10,
        ...Typography.default('semiBold'),
    },
    sectionSubtitle: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 13,
        marginBottom: 10,
        maxWidth: HANDOFF_TEXT_MAX_WIDTH,
    },
    platformToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 2,
    },
    platformGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    platformDivider: {
        width: 1,
        height: 16,
        backgroundColor: theme.colors.divider,
        opacity: 0.8,
    },
    platformLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
    },
    platformLabelSelected: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

export function WizardTerminalHandoff(props: WizardTerminalHandoffProps) {
    useUnistyles();
    const styles = stylesheet;
    const [platformSelectionBySuffix, setPlatformSelectionBySuffix] = React.useState<Record<string, 'macos' | 'linux' | 'windows'>>({});

    return (
        <View testID={props.testID} style={styles.root}>
            {props.steps.map((step) => (
                <View
                    key={step.scrollTestIDSuffix}
                    testID={`${props.testID}-step-${step.scrollTestIDSuffix}`}
                    style={styles.section}
                >
                    <Text style={styles.sectionTitle}>{step.title}</Text>
                    {step.subtitle ? <Text style={styles.sectionSubtitle}>{step.subtitle}</Text> : null}
                    <CodeBlockView
                        code={
                            step.windowsCode && (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'windows'
                                ? step.windowsCode
                                : step.code
                        }
                        language={
                            step.windowsCode && (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'windows'
                                ? (step.windowsLanguage ?? step.language ?? 'powershell')
                                : (step.language ?? 'bash')
                        }
                        showHeaderRow={Boolean(step.windowsCode)}
                        headerLeft={step.windowsCode ? (
                            <View style={styles.platformToggle}>
                                <View style={styles.platformGroup}>
                                    <Pressable
                                        testID={`${props.testID}-${step.scrollTestIDSuffix}-platform:macos`}
                                        onPress={() => setPlatformSelectionBySuffix((current) => ({
                                            ...current,
                                            [step.scrollTestIDSuffix]: 'macos',
                                        }))}
                                        accessibilityRole="button"
                                        accessibilityState={{
                                            selected: (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'macos',
                                        }}
                                    >
                                        <Text
                                            numberOfLines={1}
                                            style={[
                                                styles.platformLabel,
                                                (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'macos' ? styles.platformLabelSelected : null,
                                            ]}
                                        >
                                            {t('setupOnboarding.handoffPlatformMacosLabel')}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        testID={`${props.testID}-${step.scrollTestIDSuffix}-platform:linux`}
                                        onPress={() => setPlatformSelectionBySuffix((current) => ({
                                            ...current,
                                            [step.scrollTestIDSuffix]: 'linux',
                                        }))}
                                        accessibilityRole="button"
                                        accessibilityState={{
                                            selected: (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'linux',
                                        }}
                                    >
                                        <Text
                                            numberOfLines={1}
                                            style={[
                                                styles.platformLabel,
                                                (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'linux' ? styles.platformLabelSelected : null,
                                            ]}
                                        >
                                            {t('setupOnboarding.handoffPlatformLinuxLabel')}
                                        </Text>
                                    </Pressable>
                                </View>
                                <View style={styles.platformDivider} />
                                <Pressable
                                    testID={`${props.testID}-${step.scrollTestIDSuffix}-platform:windows`}
                                    onPress={() => setPlatformSelectionBySuffix((current) => ({
                                        ...current,
                                        [step.scrollTestIDSuffix]: 'windows',
                                    }))}
                                    accessibilityRole="button"
                                    accessibilityState={{
                                        selected: (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'windows',
                                    }}
                                >
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            styles.platformLabel,
                                            (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'macos') === 'windows' ? styles.platformLabelSelected : null,
                                        ]}
                                    >
                                        {t('setupOnboarding.handoffPlatformWindowsLabel')}
                                    </Text>
                                </Pressable>
                            </View>
                        ) : undefined}
                        wrap={false}
                        showCopyButton
                        scrollTestID={`${props.testID}-${step.scrollTestIDSuffix}`}
                    />
                </View>
            ))}
        </View>
    );
}

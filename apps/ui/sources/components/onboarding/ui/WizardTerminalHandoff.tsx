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
        alignItems: 'flex-start',
    },
    section: {
        width: '100%',
        gap: 8,
    },
    // Title/subtitle margins removed (F-W13-2): the section `gap` already
    // spaces the stack, and the setup columns must fit at 1440×900.
    sectionTitle: {
        textAlign: 'left',
        color: theme.colors.text.primary,
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    sectionSubtitle: {
        textAlign: 'left',
        color: theme.colors.text.secondary,
        fontSize: 13,
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
        backgroundColor: theme.colors.border.default,
        opacity: 0.8,
    },
    platformLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    platformLabelSelected: {
        color: theme.colors.text.primary,
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
                        // Spec §2 / F-W13-1: onboarding commands must be fully
                        // readable — wrap to multiple lines, never a horizontal
                        // overflow scroller fading unread content.
                        wrap
                        showCopyButton
                        scrollTestID={`${props.testID}-${step.scrollTestIDSuffix}`}
                    />
                </View>
            ))}
        </View>
    );
}

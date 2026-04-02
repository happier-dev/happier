import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

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
    },
}));

export function WizardTerminalHandoff(props: WizardTerminalHandoffProps) {
    useUnistyles();
    const styles = stylesheet;
    const [platformSelectionBySuffix, setPlatformSelectionBySuffix] = React.useState<Record<string, 'posix' | 'windows'>>({});

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
                            step.windowsCode && (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'posix') === 'windows'
                                ? step.windowsCode
                                : step.code
                        }
                        language={
                            step.windowsCode && (platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'posix') === 'windows'
                                ? (step.windowsLanguage ?? step.language ?? 'powershell')
                                : (step.language ?? 'bash')
                        }
                        showHeaderRow={Boolean(step.windowsCode)}
                        headerLeft={step.windowsCode ? (
                            <SegmentedTabBar
                                compact
                                testIDPrefix={`${props.testID}-${step.scrollTestIDSuffix}-platform`}
                                tabs={[
                                    { id: 'posix', label: t('setupOnboarding.handoffPlatformPosixLabel') },
                                    { id: 'windows', label: t('setupOnboarding.handoffPlatformWindowsLabel') },
                                ]}
                                activeTabId={platformSelectionBySuffix[step.scrollTestIDSuffix] ?? 'posix'}
                                onSelectTab={(tabId) => setPlatformSelectionBySuffix((current) => ({
                                    ...current,
                                    [step.scrollTestIDSuffix]: tabId,
                                }))}
                            />
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

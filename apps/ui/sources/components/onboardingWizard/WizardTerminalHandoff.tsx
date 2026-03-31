import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Text } from '@/components/ui/text/Text';

export type WizardTerminalHandoffStep = Readonly<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    code: string;
    language?: React.ComponentProps<typeof CodeBlockView>['language'];
    scrollTestIDSuffix: string;
}>;

export type WizardTerminalHandoffProps = Readonly<{
    testID: string;
    steps: readonly WizardTerminalHandoffStep[];
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 16,
        alignItems: 'center',
    },
    section: {
        width: '100%',
        gap: 10,
    },
    sectionTitle: {
        textAlign: 'center',
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 22,
    },
    sectionSubtitle: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export function WizardTerminalHandoff(props: WizardTerminalHandoffProps) {
    useUnistyles();
    const styles = stylesheet;

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
                        code={step.code}
                        language={step.language ?? 'bash'}
                        wrap
                        showCopyButton
                        scrollTestID={`${props.testID}-${step.scrollTestIDSuffix}`}
                    />
                </View>
            ))}
        </View>
    );
}

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { OsCommandBlock, type CommandOs } from '@/components/ui/code/blocks/OsCommandBlock';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HANDOFF_TEXT_MAX_WIDTH } from './handoffLayout';

export type WizardTerminalHandoffStep = Readonly<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    scrollTestIDSuffix: string;
} & (Readonly<{ commands: Readonly<Record<CommandOs, string | null>>; code?: never; language?: never }>
    | Readonly<{ code: string; language?: React.ComponentProps<typeof CodeBlockView>['language']; commands?: never }>)>;

export type WizardTerminalHandoffProps = Readonly<{
    testID: string;
    steps: readonly WizardTerminalHandoffStep[];
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: theme.space.s12,
        alignItems: 'flex-start',
    },
    section: {
        width: '100%',
        gap: theme.space.s8,
    },
    // Title/subtitle margins removed (F-W13-2): the section `gap` already
    // spaces the stack, and the setup columns must fit at 1440×900.
    sectionTitle: {
        textAlign: 'left',
        color: theme.colors.text.primary,
        ...Typography.variant('heading'),
    },
    sectionSubtitle: {
        textAlign: 'left',
        color: theme.colors.text.secondary,
        fontSize: 13,
        maxWidth: HANDOFF_TEXT_MAX_WIDTH,
    },
    codeBlockSurface: {
        backgroundColor: theme.colors.surface.base,
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
                    {step.commands ? (
                        <OsCommandBlock
                            testID={`${props.testID}-${step.scrollTestIDSuffix}`}
                            commands={step.commands}
                        />
                    ) : (
                        <CodeBlockView
                            code={step.code}
                            language={step.language ?? 'bash'}
                            wrap
                            showCopyButton
                            scrollTestID={`${props.testID}-${step.scrollTestIDSuffix}`}
                            containerStyle={styles.codeBlockSurface}
                        />
                    )}
                </View>
            ))}
        </View>
    );
}

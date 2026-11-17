import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { ToolFindText, useToolFindState } from './ToolFindText';
import { structuredToolValueToCode, type StructuredToolFact } from './structuredToolFacts';
import { toolTextBlock } from './toolDisplayTextTypes';

export type StructuredToolCardProps = Readonly<{
    /** The card's label; a typed result whose body names itself (a theme card) leaves it out. */
    title?: string;
    inputFacts?: readonly StructuredToolFact[];
    resultFacts?: readonly StructuredToolFact[];
    rawInput?: unknown | null;
    rawResult?: unknown | null;
    messageId?: string;
    /** A typed result's own body, drawn in the card after its facts (the theme card's miniature and actions). */
    children?: React.ReactNode;
}>;

export function projectStructuredToolCardDisplayText(props: StructuredToolCardProps) {
    return [
        ...toolTextBlock('tool-card-title', props.title),
        ...(props.inputFacts ?? []).flatMap((fact, index) => [
            ...toolTextBlock(`tool-input-label-${index}`, fact.label),
            ...toolTextBlock(`tool-input-value-${index}`, fact.value),
        ]),
        ...(props.rawInput != null ? toolTextBlock('tool-input', structuredToolValueToCode(props.rawInput)) : []),
        ...(props.resultFacts ?? []).flatMap((fact, index) => [
            ...toolTextBlock(`tool-result-label-${index}`, fact.label),
            ...toolTextBlock(`tool-result-value-${index}`, fact.value),
        ]),
        ...(props.rawResult != null ? toolTextBlock('tool-result', structuredToolValueToCode(props.rawResult)) : []),
    ];
}

export const StructuredToolCard = React.memo(function StructuredToolCard(props: StructuredToolCardProps) {
    const find = useToolFindState(props.messageId);
    const inputFacts = props.inputFacts ?? [];
    const resultFacts = props.resultFacts ?? [];
    const rawInput = props.rawInput ?? null;
    const rawResult = props.rawResult ?? null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {props.title ? <ToolFindText messageId={props.messageId} blockId="tool-card-title" text={props.title} style={styles.title} /> : null}
                {inputFacts.length > 0 ? (
                    <View style={styles.section}>
                        {inputFacts.map((fact, index) => (
                            <View key={`input-${fact.label}-${fact.value}`} style={styles.factRow}>
                                <ToolFindText messageId={props.messageId} blockId={`tool-input-label-${index}`} text={fact.label} style={styles.label} />
                                <ToolFindText messageId={props.messageId} blockId={`tool-input-value-${index}`} text={fact.value} style={styles.value} />
                            </View>
                        ))}
                    </View>
                ) : null}
                {rawInput !== null ? <CodeView code={structuredToolValueToCode(rawInput)} findRanges={find.ranges('tool-input')} /> : null}
                {resultFacts.length > 0 ? (
                    <View style={styles.section}>
                        {resultFacts.map((fact, index) => (
                            <View key={`result-${fact.label}-${fact.value}`} style={styles.factRow}>
                                <ToolFindText messageId={props.messageId} blockId={`tool-result-label-${index}`} text={fact.label} style={styles.label} />
                                <ToolFindText messageId={props.messageId} blockId={`tool-result-value-${index}`} text={fact.value} style={styles.value} />
                            </View>
                        ))}
                    </View>
                ) : null}
                {rawResult !== null ? <CodeView code={structuredToolValueToCode(rawResult)} findRanges={find.ranges('tool-result')} /> : null}
                {props.children}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: theme.space.s12,
        borderRadius: 8,
        backgroundColor: glassContentFill(theme.colors.surface.inset, theme.colors, { nested: true }),
        gap: theme.space.s10,
    },
    section: {
        gap: theme.space.s8,
    },
    factRow: {
        gap: theme.space.s4,
    },
    title: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.primary,
    },
}));

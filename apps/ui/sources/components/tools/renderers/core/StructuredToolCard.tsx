import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';
import { structuredToolValueToCode, type StructuredToolFact } from './structuredToolFacts';

export type StructuredToolCardProps = Readonly<{
    title: string;
    inputFacts?: readonly StructuredToolFact[];
    resultFacts?: readonly StructuredToolFact[];
    rawInput?: unknown | null;
    rawResult?: unknown | null;
}>;

export const StructuredToolCard = React.memo(function StructuredToolCard(props: StructuredToolCardProps) {
    const inputFacts = props.inputFacts ?? [];
    const resultFacts = props.resultFacts ?? [];
    const rawInput = props.rawInput ?? null;
    const rawResult = props.rawResult ?? null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>{props.title}</Text>
                {inputFacts.length > 0 ? (
                    <View style={styles.section}>
                        {inputFacts.map((fact) => (
                            <View key={`input-${fact.label}-${fact.value}`} style={styles.factRow}>
                                <Text style={styles.label}>{fact.label}</Text>
                                <Text style={styles.value}>{fact.value}</Text>
                            </View>
                        ))}
                    </View>
                ) : null}
                {rawInput !== null ? <CodeView code={structuredToolValueToCode(rawInput)} /> : null}
                {resultFacts.length > 0 ? (
                    <View style={styles.section}>
                        {resultFacts.map((fact) => (
                            <View key={`result-${fact.label}-${fact.value}`} style={styles.factRow}>
                                <Text style={styles.label}>{fact.label}</Text>
                                <Text style={styles.value}>{fact.value}</Text>
                            </View>
                        ))}
                    </View>
                ) : null}
                {rawResult !== null ? <CodeView code={structuredToolValueToCode(rawResult)} /> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    section: {
        gap: 8,
    },
    factRow: {
        gap: 4,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
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

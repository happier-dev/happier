import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { CodeView } from '@/components/CodeView';
import { maybeParseJson } from '../utils/parseJson';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function stringifyShort(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatSubtitle(input: unknown): string {
    const inputObj = asRecord(maybeParseJson(input)) ?? {};
    const keys = Object.keys(inputObj).filter((k) => !k.startsWith('_')).slice(0, 3);
    if (keys.length === 0) return '';
    const parts = keys.map((k) => `${k}=${truncate(stringifyShort((inputObj as any)[k]), 60)}`);
    return truncate(parts.join(' '), 140);
}

function getResultText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (!obj) return typeof parsed === 'string' ? parsed : null;
    const candidates = [obj.text, obj.message, obj.result, obj.output];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
    }
    return null;
}

export const UnknownToolView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;

    const subtitle = formatSubtitle(tool.input);
    const resultText = getResultText(tool.result);

    if (detailLevel === 'summary') {
        return (
            <ToolSectionView>
                <View style={styles.container}>
                    {subtitle ? (
                        <Text style={styles.subtitle} numberOfLines={2}>
                            {subtitle}
                        </Text>
                    ) : null}
                    {tool.state === 'completed' && resultText ? <CodeView code={truncate(resultText, 800)} /> : null}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <Text style={styles.title} numberOfLines={2}>
                    Tool: {tool.name}
                </Text>
                {subtitle ? (
                    <Text style={styles.subtitle} numberOfLines={3}>
                        {subtitle}
                    </Text>
                ) : null}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Input</Text>
                    <CodeView code={JSON.stringify(maybeParseJson(tool.input), null, 2)} />
                </View>
                {tool.state === 'completed' && tool.result != null ? (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>Output</Text>
                        <CodeView code={JSON.stringify(maybeParseJson(tool.result), null, 2)} />
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 10,
    },
    title: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    section: {
        gap: 6,
    },
    sectionTitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));


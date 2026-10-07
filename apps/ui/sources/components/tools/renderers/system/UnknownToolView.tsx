import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { extractStdStreams } from "@happier-dev/session-core/tools";
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


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
    const parts = keys.map((k) => `${k}=${truncate(stringifyShort(inputObj[k]), 60)}`);
    return truncate(parts.join(' '), 140);
}

function getResultText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (!obj) return typeof parsed === 'string' ? parsed : null;
    const streams = extractStdStreams(parsed);
    const streamOutput = [streams?.stdout, streams?.stderr].find((value) =>
        typeof value === 'string' && value.trim().length > 0
    );
    if (streamOutput) return streamOutput;
    const candidates = [obj.text, obj.message, obj.result, obj.output];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
    }
    return null;
}

function getUnknownToolDisplay(tool: ToolViewProps['tool']) {
    const resultText = getResultText(tool.result);
    return {
        subtitle: formatSubtitle(tool.input),
        input: JSON.stringify(maybeParseJson(tool.input), null, 2) ?? '',
        output: resultText ?? JSON.stringify(maybeParseJson(tool.result), null, 2) ?? '',
        resultText,
    };
}

export const projectUnknownDisplayText: ToolDisplayTextProjector = (tool) => {
    const display = getUnknownToolDisplay(tool);
    return [
        ...toolTextBlock('tool-body-title', tool.name),
        ...toolTextBlock('tool-body-subtitle', display.subtitle),
        ...toolTextBlock('tool-input-label', t('toolView.input')),
        ...toolTextBlock('tool-input', display.input),
        ...toolTextBlock('tool-output-label', tool.state === 'completed' && tool.result != null ? t('toolView.output') : null),
        ...toolTextBlock('tool-output', tool.state === 'completed' && tool.result != null ? display.output : null),
    ];
};

export const UnknownToolView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (detailLevel === 'title') return null;

    const { subtitle, resultText, input, output: resultCode } = getUnknownToolDisplay(tool);

    if (detailLevel === 'summary' && !find.active) {
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
                <ToolFindText style={styles.title} numberOfLines={2} text={tool.name} blockId="tool-body-title" messageId={messageId} />
                {subtitle ? (
                    <ToolFindText style={styles.subtitle} numberOfLines={3} text={subtitle} blockId="tool-body-subtitle" messageId={messageId} />
                ) : null}
                <View style={styles.section}>
                    <ToolFindText style={styles.sectionTitle} text={t('toolView.input')} blockId="tool-input-label" messageId={messageId} />
                    <CodeView code={input} findRanges={find.ranges('tool-input')} />
                </View>
                {tool.state === 'completed' && tool.result != null ? (
                    <View style={styles.section}>
                        <ToolFindText style={styles.sectionTitle} text={t('toolView.output')} blockId="tool-output-label" messageId={messageId} />
                        <CodeView code={resultCode} findRanges={find.ranges('tool-output')} />
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
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    title: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    section: {
        gap: 6,
    },
    sectionTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@happier-dev/protocol';
import { extractStdStreams, tailTextWithEllipsis } from "@happier-dev/session-core/tools";
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function coerceStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        out.push(item);
    }
    return out;
}

function coerceTextFromBlockArray(value: unknown): string | null {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const item of value) {
        if (typeof item === 'string') {
            if (item.trim()) parts.push(item);
            continue;
        }
        const obj = asRecord(item);
        if (!obj) continue;
        const text = asString(obj.text) ?? asString(obj.content) ?? asString(obj.message);
        if (text && text.trim()) parts.push(text);
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
}

function getDiff(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (obj && typeof obj.diff === 'string' && obj.diff.trim()) return obj.diff;
    return null;
}

function getPaths(result: unknown): string[] {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (obj) {
        const candidates = [obj.paths, obj.files, obj.matches];
        for (const c of candidates) {
            const arr = coerceStringArray(c);
            if (arr) return arr;
        }
    }
    const direct = coerceStringArray(parsed);
    return direct ?? [];
}

function getText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string' && parsed.trim()) return parsed;
    const obj = asRecord(parsed);
    if (!obj) return null;
    if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
    if (typeof obj.reason === 'string' && obj.reason.trim()) return obj.reason;
    if (obj.error && typeof obj.error === 'object') {
        const errObj = asRecord(obj.error);
        const msg = errObj ? asString(errObj.message) : null;
        if (msg && msg.trim()) return msg;
    }
    const candidates = [
        obj.text,
        obj.content,
        obj.body,
        obj.markdown,
        obj.message,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
        const blockText = coerceTextFromBlockArray(c);
        if (blockText && blockText.trim()) return blockText;
    }
    return null;
}

export const projectStructuredResultDisplayText: ToolDisplayTextProjector = (tool) => {
    if ((tool.state !== 'completed' && tool.state !== 'running') || !tool.result) return [];
    const streams = extractStdStreams(tool.result);
    if (tool.state === 'running' && !streams) return [];
    const diff = getDiff(tool.result);
    const paths = getPaths(tool.result);
    const text = getText(tool.result);
    const stdout = streams?.stdout?.trim() ? streams.stdout : null;
    const stderr = streams?.stderr?.trim() ? streams.stderr : null;
    return [
        ...(typeof streams?.exitCode === 'number' ? toolTextBlock('tool-exit-code', `${t('tools.structuredResult.exit')} ${streams.exitCode}`) : []),
        ...toolTextBlock('tool-stdout-label', stdout ? t('tools.structuredResult.stdout') : null),
        ...toolTextBlock('tool-stdout', stdout),
        ...toolTextBlock('tool-stderr-label', stderr ? t('tools.structuredResult.stderr') : null),
        ...toolTextBlock('tool-stderr', stderr),
        ...toolTextBlock('tool-diff-label', diff ? t('tools.structuredResult.diff') : null),
        ...toolTextBlock('tool-diff', diff),
        ...(!streams?.stdout && !streams?.stderr && !diff && text ? [
            ...toolTextBlock('tool-result-label', t('tools.structuredResult.result')),
            ...toolTextBlock('tool-result', text),
        ] : []),
        ...toolTextBlock('tool-items-label', paths.length ? t('tools.structuredResult.items') : null),
        ...paths.flatMap((path, index) => toolTextBlock(`tool-path-${index}`, path)),
    ];
};

export const StructuredResultView = React.memo<ToolViewProps>(({ tool, messageId }) => {
    const find = useToolFindState(messageId);
    const { theme } = useUnistyles();
    if (tool.state !== 'completed' && tool.state !== 'running') return null;
    if (!tool.result) return null;

    const streams = extractStdStreams(tool.result);
    const diff = getDiff(tool.result);
    const paths = getPaths(tool.result);
    const text = getText(tool.result);

    // When running, only render stdio-like streams (avoid showing partial diffs/paths).
    if (tool.state === 'running' && !streams) return null;

    if (!streams && !diff && paths.length === 0 && !text) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {typeof streams?.exitCode === 'number' && (
                    <ToolFindText messageId={messageId} blockId="tool-exit-code" text={`${t('tools.structuredResult.exit')} ${streams.exitCode}`} style={[styles.meta, { color: theme.colors.text.secondary }]} />
                )}

                {streams?.stdout && streams.stdout.trim() ? (
                    <View style={styles.block}>
                        <ToolFindText messageId={messageId} blockId="tool-stdout-label" text={t('tools.structuredResult.stdout')} style={styles.label} />
                        <CodeView
                            findRanges={find.ranges('tool-stdout')}
                            code={
                                find.active ? streams.stdout : tool.state === 'running'
                                    ? tailTextWithEllipsis(streams.stdout, 1200)
                                    : truncate(streams.stdout, 2000)
                            }
                        />
                    </View>
                ) : null}

                {streams?.stderr && streams.stderr.trim() ? (
                    <View style={styles.block}>
                        <ToolFindText messageId={messageId} blockId="tool-stderr-label" text={t('tools.structuredResult.stderr')} style={styles.label} />
                        <CodeView
                            findRanges={find.ranges('tool-stderr')}
                            code={
                                find.active ? streams.stderr : tool.state === 'running'
                                    ? tailTextWithEllipsis(streams.stderr, 900)
                                    : truncate(streams.stderr, 1200)
                            }
                        />
                    </View>
                ) : null}

                {diff && (
                    <View style={styles.block}>
                        <ToolFindText messageId={messageId} blockId="tool-diff-label" text={t('tools.structuredResult.diff')} style={styles.label} />
                        <CodeView code={find.active ? diff : truncate(diff, 2200)} findRanges={find.ranges('tool-diff')} />
                    </View>
                )}

                {!streams?.stdout && !streams?.stderr && !diff && text && (
                    <View style={styles.block}>
                        <ToolFindText messageId={messageId} blockId="tool-result-label" text={t('tools.structuredResult.result')} style={styles.label} />
                        <CodeView code={find.active ? text : truncate(text, 2200)} findRanges={find.ranges('tool-result')} />
                    </View>
                )}

                {paths.length > 0 && (
                    <View style={styles.block}>
                        <ToolFindText messageId={messageId} blockId="tool-items-label" text={t('tools.structuredResult.items')} style={styles.label} />
                        {(find.active ? paths : paths.slice(0, 8)).map((p, idx) => (
                            <ToolFindText key={`${idx}-${p}`} messageId={messageId} blockId={`tool-path-${idx}`} text={p} style={styles.path} numberOfLines={1} />
                        ))}
                        {!find.active && paths.length > 8 && (
                            <Text style={[styles.meta, { color: theme.colors.text.secondary }]}>
                                {t('tools.structuredResult.more', { count: paths.length - 8 })}
                            </Text>
                        )}
                    </View>
                )}
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
    block: {
        gap: 6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    path: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
    meta: {
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));

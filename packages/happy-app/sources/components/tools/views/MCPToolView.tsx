import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { CodeView } from '@/components/CodeView';
import { maybeParseJson } from '../utils/parseJson';

/**
 * Converts snake_case string to PascalCase with spaces
 * Example: "create_issue" -> "Create Issue"
 */
function snakeToPascalWithSpaces(str: string): string {
    return str
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Formats MCP tool name to display title
 * Example: "mcp__linear__create_issue" -> "MCP: Linear Create Issue"
 */
export function formatMCPTitle(toolName: string): string {
    // Remove "mcp__" prefix
    const withoutPrefix = toolName.replace(/^mcp__/, '');
    
    // Split into parts by "__"
    const parts = withoutPrefix.split('__');
    
    if (parts.length >= 2) {
        const serverName = snakeToPascalWithSpaces(parts[0]);
        const toolNamePart = snakeToPascalWithSpaces(parts.slice(1).join('_'));
        return `MCP: ${serverName} ${toolNamePart}`;
    }
    
    // Fallback if format doesn't match expected pattern
    return `MCP: ${snakeToPascalWithSpaces(withoutPrefix)}`;
}

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

export function formatMCPSubtitle(input: unknown): string {
    const inputObj = asRecord(maybeParseJson(input)) ?? {};
    const mcp = asRecord(inputObj._mcp);
    const display = asRecord(mcp?.display);
    if (typeof display?.subtitle === 'string' && display.subtitle.trim()) return display.subtitle.trim();

    const titleCandidate = typeof (inputObj as any).title === 'string' ? (inputObj as any).title : null;
    if (typeof titleCandidate === 'string' && titleCandidate.trim()) return truncate(titleCandidate.trim(), 140);

    const pathCandidate =
        typeof (inputObj as any).path === 'string'
            ? (inputObj as any).path
            : typeof (inputObj as any).file_path === 'string'
                ? (inputObj as any).file_path
                : typeof (inputObj as any).filePath === 'string'
                    ? (inputObj as any).filePath
                    : null;
    if (typeof pathCandidate === 'string' && pathCandidate.trim()) return truncate(pathCandidate.trim(), 140);

    const urlCandidate = typeof (inputObj as any).url === 'string' ? (inputObj as any).url : null;
    if (typeof urlCandidate === 'string' && urlCandidate.trim()) return truncate(urlCandidate.trim(), 140);

    const queryCandidate = typeof (inputObj as any).query === 'string' ? (inputObj as any).query : null;
    if (typeof queryCandidate === 'string' && queryCandidate.trim()) return truncate(queryCandidate.trim(), 140);

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

export const MCPToolView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;

    const toolName = tool.name;
    const subtitle = formatMCPSubtitle(tool.input);
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
                    {tool.state === 'completed' && resultText ? (
                        <CodeView code={truncate(resultText, 800)} />
                    ) : null}
                </View>
            </ToolSectionView>
        );
    }

    // Full view: show raw-ish input + output (ToolFullView already provides debug toggles).
    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <Text style={styles.title} numberOfLines={2}>
                    {formatMCPTitle(toolName)}
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

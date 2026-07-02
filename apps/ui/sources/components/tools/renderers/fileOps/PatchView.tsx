import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { deriveCanonicalPatchFileDiffs } from '@happier-dev/protocol/tools/v2';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { resolvePath } from '@/utils/path/pathUtils';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { buildDiffFileEntries, type DiffBlockInput, type DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { ToolFileDiffListView } from './ToolFileDiffListView';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractDiffBlocksFromResult(result: unknown): DiffBlockInput[] {
    const obj = asRecord(result);
    const metadata = asRecord(obj?.metadata);
    const files = Array.isArray(metadata?.files) ? (metadata?.files as unknown[]) : null;
    if (!files) return [];

    const out: DiffBlockInput[] = [];
    for (const raw of files) {
        const file = asRecord(raw);
        if (!file) continue;
        const relativePath = firstNonEmptyString(file.relativePath);
        const absolutePath = firstNonEmptyString(file.filePath);
        const filePath = relativePath ?? absolutePath;
        if (!filePath) continue;

        const before = typeof file.before === 'string' ? file.before : '';
        const after = typeof file.after === 'string' ? file.after : '';
        if (!before && !after) continue;

        out.push({ filePath, oldText: before, newText: after });
    }

    return out;
}

function extractDiffBlocksFromInput(input: unknown): DiffBlockInput[] {
    return deriveCanonicalPatchFileDiffs(input).map((file) => {
        if (typeof file.unifiedDiff === 'string') {
            return { filePath: file.filePath, unifiedDiff: file.unifiedDiff } satisfies DiffBlockInput;
        }
        return {
            filePath: file.filePath,
            oldText: file.oldText ?? '',
            newText: file.newText ?? '',
        } satisfies DiffBlockInput;
    });
}

function buildPatchDiffEntries(input: unknown, result: unknown): DiffFileEntry[] {
    const fromResult = extractDiffBlocksFromResult(result);
    const blocks = fromResult.length > 0 ? fromResult : extractDiffBlocksFromInput(input);
    return buildDiffFileEntries(blocks);
}

function extractFilePaths(input: unknown): string[] {
    const obj = asRecord(input);
    const changes = obj?.changes;

    if (Array.isArray(changes)) {
        return changes.flatMap((rawChange) => {
            const change = asRecord(rawChange);
            if (!change) return [];
            const kind = asRecord(change.kind);
            const path = firstNonEmptyString(kind?.move_path) ?? firstNonEmptyString(change.path) ?? firstNonEmptyString(change.filePath);
            return path ? [path] : [];
        });
    }

    const changesRecord = asRecord(changes);
    return changesRecord ? Object.keys(changesRecord) : [];
}

function extractErrorMessage(result: unknown): string | null {
    if (!result) return null;
    if (typeof result === 'string') return firstNonEmptyString(result);
    const obj = asRecord(result);
    if (!obj) return null;

    return (
        firstNonEmptyString(obj.errorMessage) ??
        firstNonEmptyString(obj.error) ??
        firstNonEmptyString(obj.message) ??
        null
    );
}

function isDeleteChange(change: unknown): boolean {
    const record = asRecord(change);
    if (!record) return false;
    const kind = asRecord(record.kind);
    const rawType = typeof record.type === 'string' ? record.type : firstNonEmptyString(kind?.type);
    const type = rawType ? rawType.toLowerCase() : null;
    return type === 'delete' || record.delete != null;
}

function hasAppliedResult(result: unknown): boolean {
    return asRecord(result)?.applied === true;
}

export const PatchView = React.memo<ToolViewProps>(({ tool, metadata, detailLevel, sessionId }) => {
    const { theme } = useUnistyles();
    const { input } = tool;
    const errorMessage = tool.state === 'error' ? extractErrorMessage(tool.result) : null;
    const files = extractFilePaths(input);
    const diffFiles = React.useMemo(() => buildPatchDiffEntries(tool.input, tool.result), [tool.input, tool.result]);
    const inputRecord = asRecord(input);
    const changes = inputRecord?.changes;

    const allDeletes =
        changes &&
        typeof changes === 'object' &&
        files.length > 0 &&
        Object.values(changes).every(isDeleteChange);

    const applied = hasAppliedResult(tool.result);

    if (diffFiles.length > 0) {
        return (
            <ToolSectionView fullWidth>
                {errorMessage ? <ToolError message={errorMessage} /> : null}
                {allDeletes || applied ? (
                    <View style={styles.statusRow}>
                        {allDeletes ? <Text style={styles.applied}>{t('common.deleted')}</Text> : null}
                        {applied ? <Text style={styles.applied}>{t('common.applied')}</Text> : null}
                    </View>
                ) : null}
                <ToolFileDiffListView files={diffFiles} detailLevel={detailLevel} sessionId={sessionId} />
            </ToolSectionView>
        );
    }

    if (files.length === 0) {
        if (errorMessage) {
            return (
                <ToolSectionView>
                    <ToolError message={errorMessage} />
                </ToolSectionView>
            );
        }
        return null;
    }

    if (files.length === 1) {
        const filePath = resolvePath(files[0], metadata);
        const fileName = filePath.split('/').pop() || filePath;

        return (
            <ToolSectionView>
                {errorMessage ? <ToolError message={errorMessage} /> : null}
                <View style={styles.fileContainer}>
                    <Octicons name="file-diff" size={16} color={theme.colors.text.secondary} />
                    <Text style={styles.fileName}>{fileName}</Text>
                    {allDeletes ? <Text style={styles.applied}>{t('common.deleted')}</Text> : null}
                    {applied ? <Text style={styles.applied}>{t('common.applied')}</Text> : null}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            {errorMessage ? <ToolError message={errorMessage} /> : null}
            <View style={styles.filesContainer}>
                {allDeletes ? <Text style={styles.applied}>{t('common.deleted')}</Text> : null}
                {applied ? <Text style={styles.applied}>{t('common.applied')}</Text> : null}
                {files.map((file, index) => {
                    const filePath = resolvePath(file, metadata);
                    const fileName = filePath.split('/').pop() || filePath;

                    return (
                        <View key={index} style={styles.fileRow}>
                            <Octicons name="file-diff" size={14} color={theme.colors.text.secondary} />
                            <Text style={styles.fileNameMulti}>{fileName}</Text>
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    statusRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    fileContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 8,
    },
    filesContainer: {
        padding: 12,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 8,
        gap: 8,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text.primary,
        fontWeight: '500',
    },
    fileNameMulti: {
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    applied: {
        marginLeft: 'auto',
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));

import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewFindingsV1, ReviewTriageStatus } from '@happier-dev/protocol';

import { sessionExecutionRunAction } from '@/sync/ops/sessionExecutionRuns';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

function formatFindingLocation(finding: ReviewFindingsV1['findings'][number]): string | null {
    if (!finding.filePath) return null;
    if (typeof finding.startLine === 'number' && typeof finding.endLine === 'number') {
        return `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
    }
    if (typeof finding.startLine === 'number') {
        return `${finding.filePath}:${finding.startLine}`;
    }
    return finding.filePath;
}

export function ReviewFindingsMessageCard(props: {
    payload: ReviewFindingsV1;
    sessionId: string;
}) {
    const [expandedFindingId, setExpandedFindingId] = React.useState<string | null>(null);
    const [draftStatusByFindingId, setDraftStatusByFindingId] = React.useState<Record<string, ReviewTriageStatus>>({});
    const [draftCommentByFindingId, setDraftCommentByFindingId] = React.useState<Record<string, string>>({});
    const [saveError, setSaveError] = React.useState<string | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);
    const [applyError, setApplyError] = React.useState<string | null>(null);
    const [isApplying, setIsApplying] = React.useState(false);
    const findings = props.payload.findings ?? [];

    React.useEffect(() => {
        const next: Record<string, ReviewTriageStatus> = {};
        const nextComments: Record<string, string> = {};
        const triageFindings = props.payload.triage?.findings ?? [];
        for (const t of triageFindings) {
            if (typeof t.id === 'string' && typeof t.status === 'string') {
                next[t.id] = t.status as ReviewTriageStatus;
                if (typeof (t as any).comment === 'string' && String((t as any).comment).trim().length > 0) {
                    nextComments[t.id] = String((t as any).comment).trim();
                }
            }
        }
        setDraftStatusByFindingId(next);
        setDraftCommentByFindingId(nextComments);
    }, [props.payload.triage]);

    const triageOverlay = React.useMemo(() => {
        const items = Object.entries(draftStatusByFindingId).map(([id, status]) => {
            const comment = typeof draftCommentByFindingId[id] === 'string' ? draftCommentByFindingId[id].trim() : '';
            return {
                id,
                status,
                ...(comment ? { comment } : {}),
            };
        });
        return { findings: items };
    }, [draftCommentByFindingId, draftStatusByFindingId]);

    const hasDraft = Object.keys(draftStatusByFindingId).length > 0;

    const handleApplyTriage = React.useCallback(() => {
        fireAndForget((async () => {
            setSaveError(null);
            setIsSaving(true);
            try {
                const res = await sessionExecutionRunAction(props.sessionId, {
                    runId: props.payload.runRef.runId,
                    actionId: 'review.triage',
                    input: triageOverlay,
                });
                if (!res.ok) {
                    setSaveError('Failed to apply triage.');
                }
            } catch (e) {
                setSaveError(e instanceof Error ? e.message : 'Failed to apply triage.');
            } finally {
                setIsSaving(false);
            }
        })(), { tag: 'ReviewFindingsMessageCard.applyTriage' });
    }, [props.sessionId, props.payload.runRef.runId, triageOverlay]);

    const acceptedFindingIds = React.useMemo(() => {
        return Object.entries(draftStatusByFindingId)
            .filter(([, status]) => status === 'accept')
            .map(([id]) => id);
    }, [draftStatusByFindingId]);

    const handleApplyAcceptedFindings = React.useCallback(() => {
        fireAndForget((async () => {
            if (acceptedFindingIds.length === 0) return;
            setApplyError(null);
            setIsApplying(true);
            try {
                const acceptedFindings = findings
                    .filter((f) => acceptedFindingIds.includes(f.id))
                    .slice(0, 50)
                    .map((f) => ({
                        id: f.id,
                        title: f.title,
                        summary: f.summary,
                        ...(f.patch ? { suggestedPatch: f.patch.slice(0, 4000) } : {}),
                    }));

                const payload = {
                    runId: props.payload.runRef.runId,
                    callId: props.payload.runRef.callId,
                    acceptedFindingIds,
                    acceptedFindings,
                };

                const text = `@happier/review.apply_accepted_findings\n${JSON.stringify(payload)}`;
                await sync.sendMessage(props.sessionId, text, 'Apply accepted findings');
            } catch (e) {
                setApplyError(e instanceof Error ? e.message : 'Failed to apply accepted findings.');
            } finally {
                setIsApplying(false);
            }
        })(), { tag: 'ReviewFindingsMessageCard.applyAcceptedFindings' });
    }, [acceptedFindingIds, findings, props.payload.runRef.callId, props.payload.runRef.runId, props.sessionId]);

    return (
        <View style={styles.container}>
            <Text style={styles.headerText}>Review findings ({findings.length})</Text>
            <Text style={styles.summaryText}>{props.payload.summary}</Text>
            {findings.map((f) => {
                const isExpanded = expandedFindingId === f.id;
                const location = formatFindingLocation(f);
                return (
                    <View key={f.id} style={styles.findingRow}>
                        <Pressable
                            onPress={() => setExpandedFindingId((prev) => (prev === f.id ? null : f.id))}
                            style={styles.findingHeader}
                        >
                            <Text style={styles.findingTitleText}>
                                [{draftStatusByFindingId[f.id] ?? 'untriaged'}] [{f.severity}/{f.category}] {f.title}
                            </Text>
                            {location ? (
                                <Text style={styles.findingLocationText} numberOfLines={1}>
                                    {location}
                                </Text>
                            ) : null}
                        </Pressable>
                        {isExpanded ? (
                            <View style={styles.findingBody}>
                                <Text style={styles.findingSummaryText}>{f.summary}</Text>
                                {f.suggestion ? (
                                    <Text style={styles.findingSuggestionText}>{f.suggestion}</Text>
                                ) : null}
                                <View style={styles.triageRow}>
                                    {(['accept', 'reject', 'defer', 'needs_refinement'] as const).map((status) => {
                                        const selected = draftStatusByFindingId[f.id] === status;
                                        return (
                                            <Pressable
                                                key={status}
                                                style={[styles.triageChip, selected && styles.triageChipSelected]}
                                                onPress={() =>
                                                    setDraftStatusByFindingId((prev) => ({ ...prev, [f.id]: status }))
                                                }
                                            >
                                                <Text style={[styles.triageChipText, selected && styles.triageChipTextSelected]}>
                                                    {status}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                                {draftStatusByFindingId[f.id] === 'needs_refinement' ? (
                                    <TextInput
                                        value={draftCommentByFindingId[f.id] ?? ''}
                                        onChangeText={(text) =>
                                            setDraftCommentByFindingId((prev) => ({ ...prev, [f.id]: String(text ?? '') }))
                                        }
                                        placeholder="Optional comment for refinement"
                                        multiline
                                        style={styles.refinementInput as any}
                                    />
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                );
            })}
            {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
            {applyError ? <Text style={styles.errorText}>{applyError}</Text> : null}
            <Pressable
                onPress={handleApplyTriage}
                style={[styles.applyButton, (!hasDraft || isSaving) && styles.applyButtonDisabled]}
                disabled={!hasDraft || isSaving}
            >
                <Text style={styles.applyButtonText}>{isSaving ? 'Applying…' : 'Apply triage'}</Text>
            </Pressable>

            <Pressable
                onPress={handleApplyAcceptedFindings}
                style={[styles.applyButton, (acceptedFindingIds.length === 0 || isApplying) && styles.applyButtonDisabled]}
                disabled={acceptedFindingIds.length === 0 || isApplying}
            >
                <Text style={styles.applyButtonText}>{isApplying ? 'Sending…' : 'Apply accepted findings'}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
    },
    headerText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '600',
    },
    summaryText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    findingRow: {
        paddingVertical: 6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        gap: 6,
    },
    findingHeader: {
        gap: 2,
    },
    findingTitleText: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    findingLocationText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
    findingBody: {
        gap: 6,
    },
    findingSummaryText: {
        color: theme.colors.text,
        fontSize: 13,
    },
    findingSuggestionText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    triageRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    triageChip: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    triageChipSelected: {
        borderColor: theme.colors.textLink,
    },
    triageChipText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
    triageChipTextSelected: {
        color: theme.colors.textLink,
        fontWeight: '600',
    },
    refinementInput: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        padding: 10,
        minHeight: 44,
        color: theme.colors.text,
    },
    errorText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    applyButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        alignItems: 'center',
    },
    applyButtonDisabled: {
        opacity: 0.5,
    },
    applyButtonText: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
}));

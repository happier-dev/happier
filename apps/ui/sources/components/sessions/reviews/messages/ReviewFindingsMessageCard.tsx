import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type {
    ReviewFinding,
    ReviewFindingsV1,
    ReviewFindingsV2,
    ReviewQuestion,
    ReviewTriageStatus,
} from '@happier-dev/protocol';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { resolveEffectiveReviewFindings } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useSessionMessages } from '@/sync/domains/state/storage';
import { sessionExecutionRunAction } from '@/sync/ops/sessionExecutionRuns';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ReviewFindingsCardPayload = ReviewFindingsV1 | ReviewFindingsV2;

type NormalizedReviewPayload = Readonly<{
    runRef: ReviewFindingsV2['runRef'];
    summary: string;
    overviewMarkdown: string;
    findings: readonly ReviewFinding[];
    questions: readonly ReviewQuestion[];
    assumptions: ReviewFindingsV2['assumptions'];
    triage?: ReviewFindingsV2['triage'];
    publication?: ReviewFindingsV2['publication'];
}>;

type ReviewTriageOverlayState = NonNullable<ReviewFindingsV2['triage']>;

const REVIEW_FINDING_ACTION_STATUSES = ['accept', 'reject', 'defer', 'needs_refinement'] as const;
const EMPTY_REVIEW_QUESTIONS: ReviewFindingsV2['questions'] = [];
const EMPTY_REVIEW_ASSUMPTIONS: ReviewFindingsV2['assumptions'] = [];

function isReviewPublication(value: unknown): value is NonNullable<ReviewFindingsV2['publication']> {
    if (!value || typeof value !== 'object') return false;
    return Array.isArray((value as { findings?: unknown }).findings);
}

function normalizePayload(payload: ReviewFindingsCardPayload): NormalizedReviewPayload {
    if ('overviewMarkdown' in payload && typeof payload.overviewMarkdown === 'string') {
        const publication = isReviewPublication(payload.publication) ? payload.publication : undefined;
        return {
            runRef: payload.runRef,
            summary: payload.summary,
            overviewMarkdown: payload.overviewMarkdown,
            findings: payload.findings ?? [],
            questions: Array.isArray(payload.questions) ? payload.questions : EMPTY_REVIEW_QUESTIONS,
            assumptions: Array.isArray(payload.assumptions) ? payload.assumptions : EMPTY_REVIEW_ASSUMPTIONS,
            ...(payload.triage ? { triage: payload.triage } : {}),
            ...(publication ? { publication } : {}),
        };
    }

    return {
        runRef: payload.runRef,
        summary: payload.summary,
        overviewMarkdown: payload.summary,
        findings: payload.findings ?? [],
        questions: EMPTY_REVIEW_QUESTIONS,
        assumptions: EMPTY_REVIEW_ASSUMPTIONS,
        ...(payload.triage ? { triage: payload.triage } : {}),
    };
}

function formatFindingLocation(finding: ReviewFinding): string | null {
    if (!finding.filePath) return null;
    if (typeof finding.startLine === 'number' && typeof finding.endLine === 'number') {
        return `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
    }
    if (typeof finding.startLine === 'number') {
        return `${finding.filePath}:${finding.startLine}`;
    }
    return finding.filePath;
}

function buildPublishedFindings(findings: readonly ReviewFinding[], acceptedFindingIds: readonly string[]): ReviewFinding[] {
    return findings.filter((finding) => acceptedFindingIds.includes(finding.id)).slice(0, 50);
}

function normalizeReviewTriageOverlayState(value: ReviewFindingsV2['triage'] | undefined): ReviewTriageOverlayState {
    const findings = Array.isArray(value?.findings)
        ? value.findings
            .map((finding) => {
                const comment = typeof finding.comment === 'string' ? finding.comment.trim() : '';
                return {
                    id: String(finding.id),
                    status: finding.status,
                    ...(comment ? { comment } : {}),
                };
            })
            .sort((left, right) => left.id.localeCompare(right.id))
        : [];
    return { findings };
}

function serializeReviewTriageOverlayState(value: ReviewFindingsV2['triage'] | undefined): string {
    return JSON.stringify(normalizeReviewTriageOverlayState(value));
}

export function ReviewFindingsMessageCard(props: {
    payload: ReviewFindingsCardPayload;
    sessionId: string;
}) {
    const normalized = React.useMemo(() => normalizePayload(props.payload), [props.payload]);
    const { messages: sessionMessages } = useSessionMessages(props.sessionId);
    const effectiveReviewFindings = React.useMemo(() => {
        return resolveEffectiveReviewFindings({
            runRef: normalized.runRef,
            initialFindings: normalized.findings ?? [],
            messages: sessionMessages,
        });
    }, [normalized.findings, normalized.runRef, sessionMessages]);
    const findings = effectiveReviewFindings.findings;
    const [expandedFindingId, setExpandedFindingId] = React.useState<string | null>(null);
    const [draftStatusByFindingId, setDraftStatusByFindingId] = React.useState<Record<string, ReviewTriageStatus>>({});
    const [draftCommentByFindingId, setDraftCommentByFindingId] = React.useState<Record<string, string>>({});
    const [composerFindingIds, setComposerFindingIds] = React.useState<readonly string[]>([]);
    const [composerReplyToQuestionId, setComposerReplyToQuestionId] = React.useState<string | null>(null);
    const [followUpMessage, setFollowUpMessage] = React.useState('');
    const [appliedTriageOverlayKey, setAppliedTriageOverlayKey] = React.useState(() => serializeReviewTriageOverlayState(normalized.triage));
    const [saveError, setSaveError] = React.useState<string | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);
    const [applyError, setApplyError] = React.useState<string | null>(null);
    const [isApplying, setIsApplying] = React.useState(false);
    const [followUpError, setFollowUpError] = React.useState<string | null>(null);
    const [isSendingFollowUp, setIsSendingFollowUp] = React.useState(false);

    React.useEffect(() => {
        const next: Record<string, ReviewTriageStatus> = {};
        const nextComments: Record<string, string> = {};
        const triageFindings = normalized.triage?.findings ?? [];
        for (const triageFinding of triageFindings) {
            if (typeof triageFinding.id === 'string' && typeof triageFinding.status === 'string') {
                next[triageFinding.id] = triageFinding.status as ReviewTriageStatus;
                if (typeof (triageFinding as any).comment === 'string' && String((triageFinding as any).comment).trim().length > 0) {
                    nextComments[triageFinding.id] = String((triageFinding as any).comment).trim();
                }
            }
        }
        setDraftStatusByFindingId(next);
        setDraftCommentByFindingId(nextComments);
    }, [normalized.triage]);

    React.useEffect(() => {
        setAppliedTriageOverlayKey(serializeReviewTriageOverlayState(normalized.triage));
    }, [normalized.triage]);

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

    const triageOverlayKey = React.useMemo(() => serializeReviewTriageOverlayState(triageOverlay), [triageOverlay]);
    const hasDraft = triageOverlay.findings.length > 0;
    const hasUnsavedTriageChanges = hasDraft && triageOverlayKey !== appliedTriageOverlayKey;
    const triageApplied = hasDraft && !hasUnsavedTriageChanges;

    const acceptedFindingIds = React.useMemo(() => {
        return Object.entries(draftStatusByFindingId)
            .filter(([, status]) => status === 'accept')
            .map(([id]) => id);
    }, [draftStatusByFindingId]);
    const supportsReviewFollowUp = React.useMemo(() => {
        const runRefRecord = normalized.runRef as unknown as Record<string, unknown>;
        const retentionPolicyRaw = runRefRecord.retentionPolicy;
        const retentionPolicy = typeof retentionPolicyRaw === 'string' ? retentionPolicyRaw.trim() : '';
        if (retentionPolicy === 'ephemeral') return false;
        if (retentionPolicy === 'resumable') return true;

        // Fail closed for legacy structured messages that do not carry retention metadata yet.
        // Runtime enforcement is authoritative.
        return false;
    }, [normalized.runRef]);

    const statusLabel = React.useCallback((status: ReviewTriageStatus | 'untriaged') => {
        switch (status) {
            case 'accept':
                return t('session.reviewFindings.status.accept');
            case 'reject':
                return t('session.reviewFindings.status.reject');
            case 'defer':
                return t('session.reviewFindings.status.defer');
            case 'needs_refinement':
                return t('session.reviewFindings.status.needsRefinement');
            case 'untriaged':
            default:
                return t('session.reviewFindings.status.untriaged');
        }
    }, []);

    const openFollowUpComposer = React.useCallback((params: Readonly<{
        findingIds?: readonly string[];
        replyToQuestionId?: string | null;
        seedMessage?: string | null;
    }>) => {
        setComposerFindingIds(params.findingIds ?? []);
        setComposerReplyToQuestionId(params.replyToQuestionId ?? null);
        setFollowUpMessage((current) => current.length > 0 ? current : (params.seedMessage ?? ''));
        setFollowUpError(null);
    }, []);

    const resetFollowUpComposer = React.useCallback(() => {
        setComposerFindingIds([]);
        setComposerReplyToQuestionId(null);
        setFollowUpMessage('');
    }, []);

    const handleApplyTriage = React.useCallback(() => {
        fireAndForget((async () => {
            setSaveError(null);
            setIsSaving(true);
            try {
                const res = await sessionExecutionRunAction(props.sessionId, {
                    runId: normalized.runRef.runId,
                    actionId: 'review.triage',
                    input: triageOverlay,
                });
                if (!res.ok) {
                    setSaveError(t('session.reviewFindings.errors.applyTriageFailed'));
                    return;
                }
                setAppliedTriageOverlayKey(triageOverlayKey);
            } catch (e) {
                setSaveError(
                    e instanceof Error ? e.message : t('session.reviewFindings.errors.applyTriageFailed')
                );
            } finally {
                setIsSaving(false);
            }
        })(), { tag: 'ReviewFindingsMessageCard.applyTriage' });
    }, [normalized.runRef.runId, props.sessionId, triageOverlay]);

    const handleSendFollowUp = React.useCallback(() => {
        const messageMarkdown = followUpMessage.trim();
        if (messageMarkdown.length === 0) return;
        fireAndForget((async () => {
            setFollowUpError(null);
            setIsSendingFollowUp(true);
            try {
                const res = await sessionExecutionRunAction(props.sessionId, {
                    runId: normalized.runRef.runId,
                    actionId: 'review.follow_up',
                    input: {
                        findingIds: [...composerFindingIds],
                        ...(composerReplyToQuestionId ? { replyToQuestionId: composerReplyToQuestionId } : {}),
                        messageMarkdown,
                    },
                });
                if (!res.ok) {
                    setFollowUpError(t('session.reviewFindings.errors.followUpFailed'));
                    return;
                }
                resetFollowUpComposer();
            } catch (e) {
                setFollowUpError(
                    e instanceof Error ? e.message : t('session.reviewFindings.errors.followUpFailed')
                );
            } finally {
                setIsSendingFollowUp(false);
            }
        })(), { tag: 'ReviewFindingsMessageCard.sendFollowUp' });
    }, [
        composerFindingIds,
        composerReplyToQuestionId,
        followUpMessage,
        normalized.runRef.runId,
        props.sessionId,
        resetFollowUpComposer,
    ]);

    const handlePublishAcceptedFindings = React.useCallback(() => {
        fireAndForget((async () => {
            if (acceptedFindingIds.length === 0) return;
            setApplyError(null);
            setIsApplying(true);
            try {
                const publishedFindings = buildPublishedFindings(findings, acceptedFindingIds);
                const threadRefs = Array.from(new Set(
                    publishedFindings.flatMap((finding) => effectiveReviewFindings.threadRefsByFindingId[finding.id] ?? []),
                ));
                const payload = {
                    sourceRunRef: normalized.runRef,
                    findingIds: acceptedFindingIds,
                    publishedFindings,
                    ...(threadRefs.length > 0 ? { threadRefs } : {}),
                };
                const text = [
                    'Please implement the accepted review findings below.',
                    '',
                    ...publishedFindings.map((finding) => `- [${finding.severity}/${finding.category}] ${finding.title}: ${finding.summary}`),
                ].join('\n');

                await sync.submitMessage(
                    props.sessionId,
                    text,
                    t('session.reviewFindings.actions.applyAcceptedFindings'),
                    {
                        happier: {
                            kind: 'review_publish_request.v1',
                            payload,
                        },
                    },
                    {
                        callerSurface: 'review_findings_apply',
                    },
                );
            } catch (e) {
                setApplyError(
                    e instanceof Error ? e.message : t('session.reviewFindings.errors.applyAcceptedFailed')
                );
            } finally {
                setIsApplying(false);
            }
        })(), { tag: 'ReviewFindingsMessageCard.publishAcceptedFindings' });
    }, [acceptedFindingIds, effectiveReviewFindings.threadRefsByFindingId, findings, normalized.runRef, props.sessionId]);

    return (
        <View style={styles.container}>
            <Text style={styles.headerText}>{t('session.reviewFindings.title', { count: findings.length })}</Text>
            <Text style={styles.summaryText}>{normalized.summary}</Text>
            <MarkdownView markdown={normalized.overviewMarkdown} textStyle={styles.markdownText} />

            {normalized.questions.length > 0 ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('session.reviewFindings.questionsTitle')}</Text>
                    {normalized.questions.map((question) => (
                        <View key={question.id} style={styles.questionRow}>
                            <Text style={styles.questionText}>{question.text}</Text>
                            {supportsReviewFollowUp ? (
                                <Pressable
                                    style={styles.secondaryButton}
                                    onPress={() =>
                                        openFollowUpComposer({
                                            findingIds: question.findingIds ?? [],
                                            replyToQuestionId: question.id,
                                        })
                                    }
                                >
                                    <Text style={styles.secondaryButtonText}>{t('session.reviewFindings.actions.answerQuestion')}</Text>
                                </Pressable>
                            ) : null}
                        </View>
                    ))}
                </View>
            ) : null}

            {normalized.assumptions.length > 0 ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('session.reviewFindings.assumptionsTitle')}</Text>
                    {normalized.assumptions.map((assumption) => (
                        <Text key={assumption.id} style={styles.assumptionText}>
                            • {assumption.text}
                        </Text>
                    ))}
                </View>
            ) : null}

            {findings.map((finding) => {
                const isExpanded = expandedFindingId === finding.id;
                const location = formatFindingLocation(finding);
                const triageStatus = (draftStatusByFindingId[finding.id] ?? 'untriaged') as ReviewTriageStatus | 'untriaged';
                return (
                    <View key={finding.id} style={styles.findingRow}>
                        <Pressable
                            testID={`review-findings-header:${finding.id}`}
                            accessibilityRole="button"
                            onPress={() => setExpandedFindingId((prev) => (prev === finding.id ? null : finding.id))}
                            style={styles.findingHeader}
                        >
                            <Text style={styles.findingTitleText}>
                                {t('session.reviewFindings.findingTitle', {
                                    status: statusLabel(triageStatus),
                                    severity: String(finding.severity ?? ''),
                                    category: String(finding.category ?? ''),
                                    title: String(finding.title ?? ''),
                                })}
                            </Text>
                            {location ? (
                                <Text style={styles.findingLocationText} numberOfLines={1}>
                                    {location}
                                </Text>
                            ) : null}
                        </Pressable>
                        {isExpanded ? (
                            <View style={styles.findingBody}>
                                <Text style={styles.findingSummaryText}>{finding.summary}</Text>
                                {finding.whyItMatters ? (
                                    <Text style={styles.findingDetailText}>{finding.whyItMatters}</Text>
                                ) : null}
                                {finding.evidence ? (
                                    <Text style={styles.findingDetailMutedText}>{finding.evidence}</Text>
                                ) : null}
                                {finding.suggestion ? (
                                    <Text style={styles.findingSuggestionText}>{finding.suggestion}</Text>
                                ) : null}
                                <View style={styles.triageRow}>
                                    {REVIEW_FINDING_ACTION_STATUSES.map((status) => {
                                        const selected = draftStatusByFindingId[finding.id] === status;
                                        return (
                                            <Pressable
                                                key={status}
                                                style={[styles.triageChip, selected && styles.triageChipSelected]}
                                                onPress={() =>
                                                    setDraftStatusByFindingId((prev) => ({ ...prev, [finding.id]: status }))
                                                }
                                            >
                                                <Text style={[styles.triageChipText, selected && styles.triageChipTextSelected]}>
                                                    {statusLabel(status)}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                                {draftStatusByFindingId[finding.id] === 'needs_refinement' ? (
                                    <TextInput
                                        value={draftCommentByFindingId[finding.id] ?? ''}
                                        onChangeText={(text) =>
                                            setDraftCommentByFindingId((prev) => ({ ...prev, [finding.id]: String(text ?? '') }))
                                        }
                                        placeholder={t('session.reviewFindings.refinementPlaceholder')}
                                        multiline
                                        style={styles.refinementInput as any}
                                    />
                                ) : null}
                                {supportsReviewFollowUp ? (
                                    <Pressable
                                        style={styles.secondaryButton}
                                        onPress={() => openFollowUpComposer({ findingIds: [finding.id] })}
                                    >
                                        <Text style={styles.secondaryButtonText}>{t('session.reviewFindings.actions.askReviewer')}</Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                );
            })}

            {supportsReviewFollowUp ? (
                <View style={styles.section}>
                    <Pressable
                        style={styles.secondaryButton}
                        onPress={() => openFollowUpComposer({})}
                    >
                        <Text style={styles.secondaryButtonText}>{t('session.reviewFindings.actions.askReviewer')}</Text>
                    </Pressable>
                    {(composerFindingIds.length > 0 || composerReplyToQuestionId || followUpMessage.length > 0) ? (
                        <View style={styles.followUpComposer}>
                            <TextInput
                                value={followUpMessage}
                                onChangeText={(text) => setFollowUpMessage(String(text ?? ''))}
                                placeholder={t('session.reviewFindings.refinementPlaceholder')}
                                multiline
                                style={styles.refinementInput as any}
                            />
                            <Pressable
                                onPress={handleSendFollowUp}
                                style={[styles.applyButton, (followUpMessage.trim().length === 0 || isSendingFollowUp) && styles.applyButtonDisabled]}
                                disabled={followUpMessage.trim().length === 0 || isSendingFollowUp}
                            >
                                <Text style={styles.applyButtonText}>
                                    {isSendingFollowUp
                                        ? t('session.reviewFindings.actions.sending')
                                        : t('session.reviewFindings.actions.sendFollowUp')}
                                </Text>
                            </Pressable>
                        </View>
                    ) : null}
                </View>
            ) : null}

            {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
            {followUpError ? <Text style={styles.errorText}>{followUpError}</Text> : null}
            {applyError ? <Text style={styles.errorText}>{applyError}</Text> : null}

            <Pressable
                testID="review-findings-apply-triage"
                accessibilityRole="button"
                onPress={handleApplyTriage}
                style={[styles.applyButton, (!hasUnsavedTriageChanges || isSaving) && styles.applyButtonDisabled]}
                disabled={!hasUnsavedTriageChanges || isSaving}
            >
                <Text style={styles.applyButtonText}>
                    {isSaving
                        ? t('session.reviewFindings.actions.applying')
                        : triageApplied
                            ? t('common.applied')
                            : t('session.reviewFindings.actions.applyTriage')}
                </Text>
            </Pressable>

            <Pressable
                testID="review-findings-publish-accepted"
                accessibilityRole="button"
                onPress={handlePublishAcceptedFindings}
                style={[styles.applyButton, (acceptedFindingIds.length === 0 || isApplying) && styles.applyButtonDisabled]}
                disabled={acceptedFindingIds.length === 0 || isApplying}
            >
                <Text style={styles.applyButtonText}>
                    {isApplying ? t('session.reviewFindings.actions.sending') : t('session.reviewFindings.actions.applyAcceptedFindings')}
                </Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 10,
    },
    headerText: {
        color: theme.colors.text.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    summaryText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    markdownText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    section: {
        gap: 8,
    },
    sectionTitle: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    questionRow: {
        gap: 8,
    },
    questionText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    assumptionText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    findingRow: {
        paddingVertical: 6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        gap: 6,
    },
    findingHeader: {
        gap: 2,
    },
    findingTitleText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    findingLocationText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
    findingBody: {
        gap: 6,
    },
    findingSummaryText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    findingDetailText: {
        color: theme.colors.text.primary,
        fontSize: 12,
    },
    findingDetailMutedText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    findingSuggestionText: {
        color: theme.colors.text.secondary,
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
        borderColor: theme.colors.border.default,
    },
    triageChipSelected: {
        borderColor: theme.colors.text.link,
    },
    triageChipText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
    triageChipTextSelected: {
        color: theme.colors.text.link,
        fontWeight: '600',
    },
    refinementInput: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        padding: 10,
        minHeight: 44,
        color: theme.colors.text.primary,
    },
    followUpComposer: {
        gap: 8,
    },
    secondaryButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        alignItems: 'center',
        alignSelf: 'flex-start',
    },
    secondaryButtonText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        fontWeight: '600',
    },
    errorText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    applyButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        alignItems: 'center',
    },
    applyButtonDisabled: {
        opacity: 0.5,
    },
    applyButtonText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
}));

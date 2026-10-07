import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { normalizeCheckpointAttributionScope } from '@happier-dev/protocol/sessions/changes/checkpointAttributionScope';
import type { CheckpointOverlapObservation, RepositoryCheckpointTurnMetadata, SessionChangeAttribution } from '@happier-dev/protocol/sessions/changes/types';

import { Popover } from '@/components/ui/popover/Popover';
import { Text } from '@/components/ui/text/Text';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

export function checkpointAttributionDescription(metadata: RepositoryCheckpointTurnMetadata | null | undefined): string | null {
    if (!metadata) return null;
    if (metadata.contentConfidence === 'unavailable') return t('files.checkpointUnavailable');
    // Protocol owns the bounded checkpoint-overlap vocabulary.
    const scope = normalizeCheckpointAttributionScope(metadata.attributionScope);
    if (scope === 'shared_worktree') return t('changedFileEvidence.overlap.observed');
    if (scope === 'no_happier_checkpoint_overlap_observed') return t('changedFileEvidence.overlap.not_observed');
    return t('changedFileEvidence.overlap.unknown');
}

/**
 * Scope-level qualification for an attributed Changed Files view. Protocol owns the derived
 * confidence; this only maps it to copy, and never states that a scope is exclusive or complete.
 * Overlap is mentioned only when it was actually observed — an unobserved overlap says nothing
 * about writers outside this process.
 */
export function sessionAttributionDescriptions(input: Readonly<{
    attribution: SessionChangeAttribution;
    checkpointOverlap: CheckpointOverlapObservation;
}>): string[] {
    return [
        t(`changedFileEvidence.attribution.${input.attribution.confidence}`),
        ...(input.checkpointOverlap === 'observed' ? [t('changedFileEvidence.overlap.observed')] : []),
    ];
}

export function sessionAttributedFileAccessibilityQualification(entry: SessionAttributedFile): string {
    return [
        t(`changedFileEvidence.content.${entry.content.confidence}`),
        ...sessionAttributionDescriptions({
            attribution: entry.attribution,
            checkpointOverlap: entry.checkpointOverlap,
        }),
    ].join('. ');
}

function truncatedEvidenceStats(evidence: SessionAttributedFile['evidence'][number]): string[] {
    if (!evidence.truncated || !evidence.stats) return [];
    const stats = evidence.stats;
    return [
        ...(stats.oldTextBytes === undefined ? [] : [t('changedFileEvidence.truncatedOldBytes', { count: stats.oldTextBytes })]),
        ...(stats.newTextBytes === undefined ? [] : [t('changedFileEvidence.truncatedNewBytes', { count: stats.newTextBytes })]),
        ...(stats.unifiedDiffBytes === undefined ? [] : [t('changedFileEvidence.truncatedDiffBytes', { count: stats.unifiedDiffBytes })]),
        ...(stats.addedLines === undefined ? [] : [t('changedFileEvidence.truncatedAddedLines', { count: stats.addedLines })]),
        ...(stats.removedLines === undefined ? [] : [t('changedFileEvidence.truncatedRemovedLines', { count: stats.removedLines })]),
    ];
}

export function ChangedFileEvidenceDisclosure({ entry, children }: Readonly<{
    entry: SessionAttributedFile;
    children?: React.ReactNode;
}>) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const content = t(`changedFileEvidence.content.${entry.content.confidence}`);
    const attribution = t(`changedFileEvidence.attribution.${entry.attribution.confidence}`);
    return (
        <View style={styles.row}>
            <Text style={styles.secondary}>{content} · {attribution}</Text>
            <Pressable
                ref={anchorRef}
                testID="changed-file-evidence-trigger"
                accessibilityRole="button"
                accessibilityLabel={t('changedFileEvidence.howDeterminedForFile', { path: entry.file.fullPath })}
                accessibilityState={{ expanded: open }}
                onPress={(event) => { event?.stopPropagation(); setOpen((value) => !value); }}
                style={styles.trigger}
            >
                <Text style={styles.link}>{t('changedFileEvidence.howDetermined')}</Text>
            </Pressable>
            {open ? <Popover
                open
                anchorRef={anchorRef}
                focusReturnRef={anchorRef}
                autoFocusOnOpen
                onRequestClose={() => setOpen(false)}
                placement="auto-vertical"
                portal={{ web: true, native: true, matchAnchorWidth: false }}
                maxWidthCap={420}
            >
                {({ maxHeight, requestClose }) => (
                    <ScrollView testID="changed-file-evidence-details" style={[styles.details, { maxHeight }]} contentContainerStyle={styles.detailsContent}>
                        <Text>{content} · {attribution}</Text>
                        <Text>{t(`changedFileEvidence.reason.${entry.attribution.reason}`)}</Text>
                        <Text>{t(`changedFileEvidence.overlap.${entry.checkpointOverlap}`)}</Text>
                        <Text>{t(`changedFileEvidence.sources.${entry.content.source}`)}</Text>
                        {entry.evidence.map((evidence, index) => (
                            <View key={index} style={styles.evidence}>
                                <Text>{t(`changedFileEvidence.sources.${evidence.source}`)} · {t(`changedFileEvidence.content.${evidence.confidence}`)}</Text>
                                {evidence.truncated ? <View testID="changed-file-evidence-truncated-notice">
                                    <Text>{t('changedFileEvidence.truncated')}</Text>
                                    {truncatedEvidenceStats(evidence).map((description) => <Text key={description}>{description}</Text>)}
                                </View> : null}
                                <Text>{t(`changedFileEvidence.kind.${evidence.changeKind}`)}{evidence.binary ? ` · ${t('changedFileEvidence.binary')}` : ''}</Text>
                                {evidence.previousFilePath ? <Text selectable>{evidence.previousFilePath} → {evidence.filePath}</Text> : null}
                                {evidence.unifiedDiff != null ? <Text selectable style={styles.code}>{evidence.unifiedDiff}</Text> : <>
                                    {evidence.oldText != null ? <><Text>{t('changedFileEvidence.before')}</Text><Text selectable style={styles.code}>{evidence.oldText}</Text></> : null}
                                    {evidence.newText != null ? <><Text>{t('changedFileEvidence.after')}</Text><Text selectable style={styles.code}>{evidence.newText}</Text></> : null}
                                </>}
                            </View>
                        ))}
                        {children}
                        <Pressable testID="changed-file-evidence-close" accessibilityRole="button" onPress={() => requestClose('selection')} style={styles.trigger}>
                            <Text style={styles.link}>{t('common.close')}</Text>
                        </Pressable>
                    </ScrollView>
                )}
            </Popover> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: { paddingHorizontal: 12, paddingBottom: 8, columnGap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
    secondary: { color: theme.colors.text.secondary, flexShrink: 1 },
    link: { color: theme.colors.text.link },
    trigger: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
    details: { backgroundColor: theme.colors.surface.base, borderRadius: 12 },
    evidence: { gap: 6 },
    code: { ...Typography.mono(), color: theme.colors.text.primary },
    detailsContent: { padding: 16, gap: 12 },
}));

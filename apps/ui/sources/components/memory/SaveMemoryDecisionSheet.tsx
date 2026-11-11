import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HAPPIER_PAGE_METRICS,
} from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { LocalDateTimeEditor } from '@/components/ui/dateTime/LocalDateTimeEditor';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { showArtifactHistorySheet } from '@/components/artifacts/ArtifactHistorySheet';
import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { MemoryCreationReceipt } from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';

import { MarkdownExcerpt } from '@/components/markdown/MarkdownExcerpt';

import type { SaveMemoryDecisionSeed } from './memoryDecisionSeed';
import { MemoryDuplicateChoice } from './MemoryDocumentBody';
import { MemoryDuplicateSavedFact } from './MemoryDuplicateSavedFact';
import { SaveMemoryDecisionSaved } from './SaveMemoryDecisionSaved';
import {
  memoryDecisionChosenLabel,
  memoryDecisionSheetRowStyle,
  memoryDecisionTargetId,
  SaveMemoryDecisionTargetChooser,
} from './SaveMemoryDecisionTarget';
import { useSaveMemoryDecision } from './useSaveMemoryDecision';

type FormProps = Readonly<{
  seed: SaveMemoryDecisionSeed;
  onClose: () => void;
  onSaved: () => void;
  /** The saved document can be opened/attached through the existing Context flow. */
  onCreatedMemory?: (receipt: MemoryCreationReceipt) => void;
}>;

type Expiry = 'never' | 'date';

/**
 * Save as decision (lab K2 `S`/`Sd`, C6 §5): the decision, its reason, the exact message it was decided
 * in and an expiry (Never or a date). It saves through `memory.decision.save`: a Session's message to that
 * Session's own memory, a Discussion's message to the person's own memory; a person's save stamps their own approval. When that memory already has something similar, the same
 * form leads with it and asks Update / Replace / Keep both, keeping everything typed.
 */
export function SaveMemoryDecisionForm(props: FormProps) {
  const model = useSaveMemoryDecision(props);
  return <SaveMemoryDecisionFormContent model={model} quote={props.seed.quote} onClose={props.onClose} onSaved={props.onSaved} />;
}

function SaveMemoryDecisionFormContent(props: Readonly<{
  model: ReturnType<typeof useSaveMemoryDecision>;
  /** The source message, quoted under the fields; absent when the seed has no message text to show. */
  quote?: string;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const { model } = props;
  const { text, setText, reason, setReason, expiry, setExpiry, nowMs, expiryDraft, setExpiryDraft,
    review, choice, setChoice, candidateId, setCandidateId, notice, busy, canSave, save, sessionSource,
    creationReceipt, selectedTarget, targets } = model;
  // The decision is persisted but its Context did not take it: the sheet turns to that recovery.
  const unattached = creationReceipt?.attachment === 'conflict' ? creationReceipt : null;
  const chosen = selectedTarget
    ? targets.find(row => memoryDecisionTargetId(row.target) === memoryDecisionTargetId(selectedTarget)) ?? null
    : null;
  const chosenLabel = memoryDecisionChosenLabel(model);
  // A saved fact the review is looking at, in place of the form; everything typed and chosen stays.
  const [viewingFactId, setViewingFactId] = React.useState<string | null>(null);
  const viewing = review && review.candidates.some((entry) => entry.factId === viewingFactId) ? viewingFactId : null;
  const { binding: reviewScope } = useServerCredentialAccountScopeBinding(review?.ref.serverId);

  const expiryOptions = React.useMemo(
    (): ReadonlyArray<SegmentedChoiceOption<Expiry>> => [
      { id: 'never', label: t('memoryContext.memory.sheetExpiresNever') },
      { id: 'date', label: t('memoryContext.memory.sheetExpiresOnDate') },
    ],
    [],
  );
  const saveLabel = !review
    ? t('memoryContext.memory.sheetSave')
    : choice === 'update'
      ? t('memoryContext.memory.sheetSaveUpdate')
      : choice === 'replace'
        ? t('memoryContext.memory.sheetSaveReplace')
        : t('memoryContext.memory.duplicateKeepBoth');

  return (
    <View testID="save-memory-decision" style={styles.form}>
      <View style={styles.header}>
        <Icon name="seal-check" />
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            {t('memoryContext.memory.sheetTitle')}
          </Text>
          <Text style={styles.meta}>
            {selectedTarget?.scope === 'project' && chosenLabel !== null
              ? t('memoryContext.memory.projectScope', { project: chosenLabel })
              : t(
                  sessionSource && !selectedTarget
                    ? 'memoryContext.memory.sheetTarget'
                    : 'memoryContext.memory.sheetTargetPerson',
                )}
          </Text>
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {notice === 'pending' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.pending"
            busy
            reason={t('memoryContext.memory.pending')}
          />
        ) : notice === 'conflict' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.conflict"
            tone="warning"
            reason={t('memoryContext.memory.sheetConflict')}
            action={review?.ref.serverId && reviewScope ? { label: t('memoryContext.memory.reviewChange'),
              testID: 'save-memory-decision.conflict-action', onPress: () => showArtifactHistorySheet({
              artifactId: review.ref.artifactId,
              canRestore: false,
              compareFromBodyVersion: review.revision.bodyVersion,
              client: createArtifactActionsClient(reviewScope),
            }) } : undefined}
          />
        ) : notice === 'disclosure' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.disclosure"
            tone="warning"
            reason={t('memoryContext.memory.sheetDisclosureDenied')}
          />
        ) : notice === 'sourceUnavailable' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.sourceUnavailable"
            tone="warning"
            reason={t('memoryContext.memory.sheetSourceUnavailable')}
          />
        ) : notice === 'refused' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.refused"
            tone="warning"
            reason={t('memoryContext.memory.sheetRefused')}
          />
        ) : null}
        {unattached ? (
          <SaveMemoryDecisionSaved
            receipt={unattached}
            workspaceRef={chosen?.workspaceRef ?? null}
            projectName={chosenLabel ?? ''}
            onDone={props.onSaved}
          />
        ) : null}
        {review && viewing ? (
          <MemoryDuplicateSavedFact
            testID="save-memory-decision.savedFact"
            review={review}
            factId={viewing}
            serverId={review.ref.serverId ?? ''}
            viewerAccountId={null}
            onBack={() => setViewingFactId(null)}
          />
        ) : null}
        {/* The form stays mounted while a saved fact is open, so its fields and choices come back as left. */}
        <View style={viewing ? styles.hidden : styles.formFields}>
        {review ? (
          <MemoryDuplicateChoice
            testID="save-memory-decision.duplicate"
            review={review}
            newText={text}
            candidateId={candidateId}
            onCandidateChange={setCandidateId}
            choice={choice}
            onChoiceChange={setChoice}
            onViewCandidate={setViewingFactId}
            disabled={busy}
          />
        ) : null}
        <FieldItem label={t('memoryContext.memory.sheetDecisionLabel')}>
          <FieldTextInput
            testID="save-memory-decision.text"
            accessibilityLabel={t('memoryContext.memory.sheetDecisionLabel')}
            placeholder={t('memoryContext.memory.sheetDecisionPlaceholder')}
            value={text}
            onChangeText={setText}
            multiline
            minLines={1}
            growWithText
            autoFocus
            selectTextOnFocus
          />
        </FieldItem>
        <FieldItem label={t('memoryContext.memory.sheetReasonLabel')}>
          <FieldTextInput
            testID="save-memory-decision.reason"
            accessibilityLabel={t('memoryContext.memory.sheetReasonLabel')}
            placeholder={t('memoryContext.memory.sheetReasonPlaceholder')}
            value={reason}
            onChangeText={setReason}
            multiline
            minLines={2}
            growWithText
          />
        </FieldItem>
        {props.quote ? (
          <MarkdownExcerpt
            testID="save-memory-decision.source"
            markdown={props.quote}
            source={t(sessionSource ? 'memoryContext.memory.sheetSource' : 'memoryContext.memory.sheetSourceMessage')}
            showMore={t('memoryContext.memory.sheetSourceShowMore')}
            showLess={t('memoryContext.memory.sheetSourceShowLess')}
          />
        ) : (
          <View style={styles.source}>
            <Icon name="quotes" size={14} />
            <Text style={styles.meta}>
              {t(
                sessionSource
                  ? 'memoryContext.memory.sheetSource'
                  : 'memoryContext.memory.sheetSourceMessage',
              )}
            </Text>
          </View>
        )}
        <SaveMemoryDecisionTargetChooser model={model} />
        <SegmentedChoiceItem<Expiry>
          title={t('memoryContext.memory.sheetExpires')}
          options={expiryOptions}
          value={expiry}
          onChange={setExpiry}
          testIDPrefix="save-memory-decision.expiry"
          accessoryLayout="adaptive"
          showDivider={false}
          style={memoryDecisionSheetRowStyle}
          disabled={busy}
        />
        {expiry === 'date' ? (
          <LocalDateTimeEditor
            nowMs={nowMs}
            value={expiryDraft}
            onChange={setExpiryDraft}
            testIDPrefix="save-memory-decision.expiresAt"
            labels={{
              date: t('memoryContext.memory.sheetExpiryDate'),
              time: t('memoryContext.memory.sheetExpiryTime'),
              pastInstant: t('memoryContext.memory.sheetExpiryPast'),
            }}
          />
        ) : null}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Text style={[styles.meta, styles.approval]} numberOfLines={1}>
          {t('memoryContext.memory.sheetApprovedByYouNow')}
        </Text>
        {unattached ? null : (
          <RoundButton
            testID="save-memory-decision.cancel"
            size="small"
            display="inverted"
            title={notice === 'pending' ? t('common.close') : t('common.cancel')}
            onPress={props.onClose}
          />
        )}
        {unattached ? (
          <RoundButton
            testID="save-memory-decision.done"
            size="small"
            title={t('common.done')}
            onPress={props.onSaved}
          />
        ) : (
          <RoundButton
            testID="save-memory-decision.save"
            size="small"
            title={saveLabel}
            disabled={!canSave}
            loading={busy}
            action={save}
          />
        )}
      </View>
    </View>
  );
}

/**
 * The panel anchored to the action that opened it on a wide window, the shared phone sheet (the
 * form carries its own header) on a phone. Message action menus and C1's answered lasting question
 * ("Remember this") open this same sheet with their seed.
 */
export function SaveMemoryDecisionSheet(
  props: FormProps & Readonly<{ anchorRef: React.RefObject<View | null> }>,
) {
  // The responsive Popover replaces its presentation subtree; draft and custody belong to the open sheet.
  const model = useSaveMemoryDecision(props);
  return (
    <Popover
      open
      phonePresentation="sheet"
      sheetHeader="none"
      sheetMaterial="solid"
      accessibilityLabel={t('memoryContext.memory.sheetTitle')}
      anchorRef={props.anchorRef}
      placement="auto-vertical"
      maxWidthCap={HAPPIER_PAGE_METRICS.dialogWidthPx.default}
      // The panel keeps a gutter from the window edge however tall a duplicate review grows.
      edgePadding={POPOVER_EDGE_PADDING}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
      onRequestClose={props.onClose}
    >
      {({ maxHeight, presentation }) => presentation === 'sheet' ? (
        <View style={[styles.sheetBody, { maxHeight }]}>
          <SaveMemoryDecisionFormContent
            model={model}
            quote={props.seed.quote}
            onClose={props.onClose}
            onSaved={props.onSaved}
          />
        </View>
      ) : (
        <FloatingOverlay surfaceChrome="theme" maxHeight={maxHeight}>
          <View style={[styles.popoverBody, { maxHeight }]}>
            <SaveMemoryDecisionFormContent
              model={model}
              quote={props.seed.quote}
              onClose={props.onClose}
              onSaved={props.onSaved}
            />
          </View>
        </FloatingOverlay>
      )}
    </Popover>
  );
}

const POPOVER_EDGE_PADDING = { horizontal: 12, vertical: 12 } as const;

const styles = StyleSheet.create((theme) => ({
  form: {
    paddingVertical: theme.space.s16,
    gap: theme.space.s12,
    flexShrink: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
  },
  headerText: { flex: 1, minWidth: 0 },
  heading: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: theme.space.s16, gap: theme.space.s12 },
  // The form's own fields keep the body's rhythm inside their wrapper.
  formFields: { gap: theme.space.s12 },
  hidden: { display: 'none' },
  source: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
  approval: { flex: 1, minWidth: 0 },
  sheetBody: { alignSelf: 'stretch', flexShrink: 1, minHeight: 0 },
  popoverBody: {
    width: HAPPIER_PAGE_METRICS.dialogWidthPx.default,
    maxWidth: '100%',
    // A taller review shrinks the form's scroll area; the footer actions stay inside the overlay.
    flexShrink: 1,
    minHeight: 0,
  },
}));

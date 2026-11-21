import {
  HappierDisclosure,
  HappierSkeletonBlock,
  happierPageTextMetrics,
  resolveHappierFutureLocalDateTime,
  toHappierLocalDateTimeDraft,
  type HappierLocalDateTimeDraft,
} from '@happier-dev/plugin-ui/presentation';
import {
  HappierMemoryDuplicateChoice,
  HappierMemoryFactRow,
  type HappierMemoryDuplicateChoiceControlProps,
  type HappierMemoryDuplicateChoiceKind,
  type HappierMemoryDuplicateChoiceTextProps,
  type HappierMemoryFactRowHost,
} from '@happier-dev/plugin-ui/components';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import {
  MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  isMemoryFactRenewableV1,
  type MemoryFactV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import * as React from 'react';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { LocalDateTimeEditor } from '@/components/ui/dateTime/LocalDateTimeEditor';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { reanimatedDisclosureMotion } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { motionTokens } from '@/components/ui/motion';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { Text } from '@/components/ui/text/Text';
import { showArtifactHistorySheet } from '@/components/artifacts/ArtifactHistorySheet';
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  memoryDocumentActions,
  readMemoryActionOutcome,
  readMemoryCreationReceipt,
  readMemoryDuplicateReview,
  type MemoryCreationReceipt,
  type MemoryDocumentTarget,
  type MemorySessionTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { memoryDocumentHref } from './memoryDocumentRoutes';
import type { MemoryDocumentSource } from './useMemoryDocument';
import { MemoryDuplicateSavedFact } from './MemoryDuplicateSavedFact';
import { MemoryMachineChoice } from './MemoryMachineChoice';
import { memoryDecisionSheetRowStyle } from './SaveMemoryDecisionTarget';
import { useMemoryDocumentSummary } from './useMemoryDocumentSummary';
import { useMemoryOffline } from './useMemoryOffline';
import { MemoryDocumentNotices } from './MemoryDocumentNotices';
import { readMemoryFactSource } from './useMemoryFactSource';
import { formatMemoryDate, useMemoryFactAttribution } from './useMemoryFactAttribution';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export { formatMemoryDate } from './useMemoryFactAttribution';

/** A fact this fresh reads "Just now" rather than today's date. */
const JUST_NOW_MS = 60_000;
/** Where a new expiry date starts: the Save as decision sheet's own default. */
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

type Expiry = 'never' | 'date';
/** The edit form's expiry: a fact's own date while it lies ahead; a lapsed or open-ended one starts a month out. */
type ExpiryDraft = Readonly<{ kind: Expiry; date: HappierLocalDateTimeDraft; nowMs: number }>;

function expiryDraftFor(fact: MemoryFactV1, nowMs: number): ExpiryDraft {
  const ahead = fact.expiresAtMs !== undefined && fact.expiresAtMs > nowMs;
  return {
    // A renewal keeps the fact's intent to end, at a new date the person sees before saving.
    kind: fact.expiresAtMs === undefined ? 'never' : 'date',
    date: toHappierLocalDateTimeDraft(new Date(ahead ? fact.expiresAtMs! : nowMs + DEFAULT_EXPIRY_MS)),
    nowMs,
  };
}

type Notice = 'pending' | 'conflict' | 'refused' | null;

export type DuplicateReview = NonNullable<ReturnType<typeof readMemoryDuplicateReview>>;
export type DuplicateChoiceKind = HappierMemoryDuplicateChoiceKind;

/** The candidate the review leads with: a word-for-word match before a related one. */
export function leadingCandidateId(review: DuplicateReview): string | null {
  return (review.candidates.find((entry) => entry.match === 'exact') ?? review.candidates[0])?.factId ?? null;
}

/** A forgotten fact holding its place while its row collapses; `settled` once the row has closed. */
type CollapsingFact = Readonly<{ fact: MemoryFactV1; index: number; settled: boolean }>;

const NO_FACT_IDS: ReadonlySet<string> = new Set();
const NO_FACTS: readonly MemoryFactV1[] = [];

function isExpiredFact(fact: MemoryFactV1, nowMs: number): boolean {
  return fact.expiresAtMs !== undefined && fact.expiresAtMs <= nowMs;
}

function orderDecisionsFirst(facts: readonly MemoryFactV1[] | undefined): readonly MemoryFactV1[] {
  if (!facts || facts.length === 0) return NO_FACTS;
  if (!facts.some((fact) => fact.decision)) return facts;
  return [...facts.filter((fact) => fact.decision), ...facts.filter((fact) => !fact.decision)];
}

/**
 * The rows to draw: the shown facts, with each forgotten fact kept at its place until its row has
 * collapsed, even once the refreshed view no longer holds it.
 */
function mergeCollapsingFacts(
  shown: readonly MemoryFactV1[],
  collapsing: readonly CollapsingFact[],
): readonly Readonly<{ fact: MemoryFactV1; leaving: boolean }>[] {
  const rows = shown.map((fact) => ({
    fact,
    leaving: collapsing.some((entry) => entry.fact.id === fact.id),
  }));
  for (const entry of collapsing) {
    if (entry.settled || rows.some((row) => row.fact.id === entry.fact.id)) continue;
    rows.splice(Math.min(entry.index, rows.length), 0, { fact: entry.fact, leaving: true });
  }
  return rows;
}

/**
 * The facts that landed while this document or topic was on screen (lab `c-mem W`): none on its first
 * read, then each id that appears afterwards, once.
 */
function useArrivedFactIds(viewKey: string | null, facts: readonly MemoryFactV1[]): ReadonlySet<string> {
  const seenRef = React.useRef<Readonly<{ key: string; ids: ReadonlySet<string> }> | null>(null);
  const seen = viewKey !== null && seenRef.current?.key === viewKey ? seenRef.current.ids : null;
  const arrived = React.useMemo(
    () => (seen === null ? NO_FACT_IDS : new Set(facts.filter((fact) => !seen.has(fact.id)).map((fact) => fact.id))),
    [facts, seen],
  );
  React.useEffect(() => {
    if (viewKey === null) return;
    const previous = seenRef.current?.key === viewKey ? seenRef.current.ids : null;
    if (previous && facts.every((fact) => previous.has(fact.id))) return;
    seenRef.current = { key: viewKey, ids: new Set([...(previous ?? []), ...facts.map((fact) => fact.id)]) };
  }, [facts, viewKey]);
  return arrived;
}

/** The topic's name as people read it; the reserved archive topic has a translated name. */
export function memoryTopicLabel(title: string): string {
  return title === MEMORY_ARCHIVE_TOPIC_TITLE_V1
    ? t('memoryContext.memory.archive')
    : title;
}

export type MemoryDocumentBodyProps = Readonly<{
  testID: string;
  source: MemoryDocumentSource;
  /** The Home the surface is about; names the document's Home when its reference does not. */
  serverId: string;
  /** Key facts shown before "Show all N"; omit on the document's own pages, which list every fact. */
  collapsedFactCount?: number;
  /** Who can see it and how agents may write to it, in words. */
  footer?: string;
  readOnly?: boolean;
  /** The section's "+" opens the remember form; the section header owns the button. */
  composing: boolean;
  onComposingChange: (open: boolean) => void;
  /** No document is attached yet: the first fact goes to the Session's own memory, which the host creates. */
  sessionTarget?: MemorySessionTarget | null;
  scopeTarget?: MemoryScopeTargetV1;
  /** A fresh admitted preparation, not the Session's last accepted turn. */
  preparationScope?: MemorySearchScope;
  preparationBasis?: string;
  /** False when the entry carrying this document is switched off: nothing is indexed, so no counts are read. */
  inUse?: boolean;
  onCreatedMemory?: (receipt: MemoryCreationReceipt) => void;
  /** The composition owner presents these candidates in the current save sheet, preserving its draft. */
  onDuplicateReview?: (review: NonNullable<ReturnType<typeof readMemoryDuplicateReview>>) => void;
  emptyText: string;
  /**
   * How the host says "nothing remembered yet" in its own empty treatment (the Work pane's one quiet
   * line). Omitted, the document's pages draw it as an information row.
   */
  renderEmpty?: (line: Readonly<{ testID: string; text: string }>) => React.ReactNode;
  /** Opens the Session a fact came from, through the host's Session navigation owner. */
  onOpenSession?: (ref: Readonly<{ serverId: string; sessionId: string; messageId?: string }>) => void;
  /** The document's own pages open a fact's detail (reason, source, approval, history) from its row. */
  onOpenFact?: (fact: MemoryFactV1) => void;
  /** The fact whose detail is open beside the list. */
  selectedFactId?: string | null;
  /** The signed-in Account, so its own approvals read "you" even while no write target is admitted. */
  viewerAccountId?: string | null;
  /**
   * The document's own index page (lab K2 `A`): decisions and notes are their own counted sections,
   * and expired facts fold into one line (kept in history, out of context) that shows them on demand.
   * The body then draws its own sections, so the caller does not wrap it in one.
   */
  grouped?: boolean;
  /** Opens this fact's edit form on arrival (a fact page's Edit returns to the list to edit it). */
  editFactId?: string;
}>;

/**
 * The one renderer of a `memory_doc.v1` document (lab `c-mem`, `c-ctx`; D48): the summary line, the
 * index's key facts as one-line rows, then its topics (title + one-line summary) which open their own
 * page, and the access line. Work › Memory, Settings › Context and Project › Context all draw their
 * memory with it, and the document's own pages reuse it with every fact listed. Remember, edit and
 * forget are the public `memory.*` Actions against the version on screen; a conflict shows the
 * current version and keeps what was typed.
 */
export const MemoryDocumentBody = React.memo(function MemoryDocumentBody(
  props: MemoryDocumentBodyProps,
) {
  const commandBridge = useCurrentUiContextCommandBridge();
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const { source, serverId, testID, onComposingChange, onCreatedMemory } = props;
  const router = useRouter();
  const view = source.view;
  const target = source.target;
  const topic = view?.topic ?? null;
  const summary = useMemoryDocumentSummary({ source, serverId,
    scope: props.preparationScope, preparationBasis: props.preparationBasis, inUse: props.inUse,
    enabled: topic === null });
  const fresh = source.status === 'ready' && !source.stale;
  const countLabel = (count: number) => t('memoryContext.memory.factCount', { count });
  const archive = topic?.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1;
  const writable = !props.readOnly && !archive;
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [conflictTarget, setConflictTarget] = React.useState<MemoryDocumentTarget | null>(null);
  const [storedEditingId, setEditingId] = React.useState<string | null>(null);
  const [storedDraft, setDraft] = React.useState('');
  const [storedDraftTopic, setDraftTopic] = React.useState('');
  const [draftCustody, setDraftCustody] = React.useState<MemoryDocumentSource['draftCustody']>(null);
  // A similar saved fact, found by the write owner before anything was saved: the same form asks
  // what to do with it, keeping what was typed.
  const [storedReview, setReview] = React.useState<DuplicateReview | null>(null);
  const [choiceKind, setChoiceKind] = React.useState<DuplicateChoiceKind>('update');
  const [candidateId, setCandidateId] = React.useState<string | null>(null);
  // The saved fact a review is looking at, in place of the comparison; the draft and effect stay.
  const [viewingFactId, setViewingFactId] = React.useState<string | null>(null);
  // The edited fact's expiry: an explicit Never or a date, written with its text (C6 renew).
  const [expiryDraft, setExpiryDraft] = React.useState<ExpiryDraft | null>(null);
  // An Undo whose restore met a related saved fact: the same comparison asks before it comes back.
  const [restoring, setRestoring] = React.useState<Readonly<{
    fact: MemoryFactV1; target: MemoryDocumentTarget; topic?: string;
  }> | null>(null);
  const draftCustodyRef = React.useRef(source.draftCustody);
  draftCustodyRef.current = source.draftCustody;
  const draftCurrent = draftCustody !== null && draftCustody.isCurrent()
    && draftCustody.key === source.draftCustody?.key;
  const editingId = draftCurrent ? storedEditingId : null;
  const draft = draftCurrent ? storedDraft : '';
  const draftTopic = draftCurrent ? storedDraftTopic : '';
  const review = draftCurrent ? storedReview : null;
  const draftRef = React.useRef<React.ElementRef<typeof FieldTextInput>>(null);
  const reducedMotion = useReducedMotionPreference();
  // A forgotten fact keeps its place while its row collapses (lab `c-mem` Motion), then leaves.
  const [collapsing, setCollapsing] = React.useState<readonly CollapsingFact[]>([]);
  const factsRef = React.useRef<readonly MemoryFactV1[]>([]);
  // Decisions lead, then notes, each in their saved order (lab K2): one list, not a second destination.
  const orderedFacts = React.useMemo(() => orderDecisionsFirst(view?.facts), [view?.facts]);
  factsRef.current = orderedFacts;
  const [showExpired, setShowExpired] = React.useState(false);
  const now = Date.now();

  const refresh = source.refresh;
  const settle = React.useCallback(
    async (run: () => Promise<ActionExecuteResult>): Promise<Readonly<{ applied: boolean; target: MemoryDocumentTarget | null }>> => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await run();
        const outcome = readMemoryActionOutcome(result);
        const receipt = readMemoryCreationReceipt(result);
        const review = readMemoryDuplicateReview(result);
        if (review) {
          setReview(review);
          setCandidateId(leadingCandidateId(review));
          setChoiceKind('update');
          setViewingFactId(null);
          props.onDuplicateReview?.(review);
        }
        // A refusal is said in place, beside what it did not change, until the next attempt.
        if (outcome === 'pending' || outcome === 'conflict' || outcome === 'refused') setNotice(outcome);
        if (outcome === 'conflict') setConflictTarget(source.target);
        // A saved-but-unattached result is not an unsaved revision conflict. Keep its exact document reachable,
        // and close its draft so retrying cannot create a second copy of that fact.
        if (receipt) onCreatedMemory?.(receipt);
        // A conflict hands back the current version; show it and keep what was typed. A review saved
        // nothing, so the document is not read again under the open comparison.
        const target = outcome !== 'refused' && outcome !== 'review' ? await refresh() : null;
        return { applied: outcome === 'applied' || receipt !== null, target };
      } catch {
        setNotice('refused');
        return { applied: false, target: null };
      } finally {
        setBusy(false);
      }
    },
    [onCreatedMemory, props.onDuplicateReview, refresh, source.target],
  );

  const closeDraft = React.useCallback(() => {
    setDraftCustody(null);
    setEditingId(null);
    setDraft('');
    setDraftTopic('');
    setReview(null);
    setViewingFactId(null);
    setExpiryDraft(null);
    setRestoring(null);
    onComposingChange(false);
  }, [onComposingChange]);

  React.useEffect(() => {
    if (draftCustody && !draftCurrent) closeDraft();
  }, [closeDraft, draftCurrent, draftCustody]);

  const changeDraft = React.useCallback((text: string) => {
    if (!source.draftCustody?.isCurrent()) return;
    setDraftCustody(source.draftCustody);
    setDraft(text);
  }, [source.draftCustody]);
  const changeDraftTopic = React.useCallback((text: string) => {
    if (!source.draftCustody?.isCurrent()) return;
    setDraftCustody(source.draftCustody);
    setDraftTopic(text);
  }, [source.draftCustody]);

  const sessionTarget = props.sessionTarget ?? null;
  const scopeTarget = props.scopeTarget;
  const canCreate = source.status === 'none' && view === null && Boolean(scopeTarget || sessionTarget);
  const save = React.useCallback(() => {
    // A retained handler cannot submit unpublished text after its Account has retired.
    if (!draftCustody?.isCurrent() || draftCustody.key !== source.draftCustody?.key) return;
    const text = draft.trim();
    if (!text) return;
    const named = draftTopic.trim();
    const fallback = sessionTarget;
    if (!target && !canCreate) return;
    const duplicateChoice = review ? reviewedDuplicateChoice(review, choiceKind, candidateId) : undefined;
    const choice = duplicateChoice ? { duplicateChoice } : {};
    const expiresAtMs = editingId ? resolveExpiry(expiryDraft) : null;
    if (expiresAtMs === undefined) return;
    // Replaying a choice through a Session or scope names the document that was reviewed.
    const reviewed = review ? { reviewedTarget: { ref: review.ref, expectedRevision: review.revision } } : {};
    fireAndForget(
      (async () => {
        const { applied } = await settle(() => {
          if (editingId && target)
            // An expired fact is read on the Archive page (the read projection moves it there) but is
            // still stored where it was saved, so its renewal is a document-level edit, not an archive one.
            return memoryDocumentActions.update(archive ? { ...target, topic: undefined } : target, {
              factId: editingId,
              text,
              // Always explicit: Never clears the expiry, a date sets it (an expired fact is renewed).
              expiresAtMs,
              ...choice,
            });
          if (target) {
            return memoryDocumentActions.remember(
              topic || !named ? target : { ...target, topic: named },
              { text, ...choice },
            );
          }
          if (scopeTarget)
            return memoryDocumentActions.rememberInScope(scopeTarget, {
              text,
              ...(named ? { topic: named } : {}),
              ...choice,
              ...reviewed,
            }, serverId);
          if (!fallback) throw new Error('memory_target_unavailable');
          return memoryDocumentActions.rememberInSession(fallback, {
            text,
            ...(named ? { topic: named } : {}),
            ...choice,
            ...reviewed,
          });
        });
        if (applied) closeDraft();
      })(),
      { tag: 'MemoryDocumentBody.save' },
    );
  }, [
    candidateId,
    choiceKind,
    review,
    closeDraft,
    draft,
    draftTopic,
    draftCustody,
    source.draftCustody,
    editingId,
    expiryDraft,
    canCreate,
    scopeTarget,
    serverId,
    sessionTarget,
    settle,
    target,
    topic,
  ]);

  // Resubmits the exact Undo with the chosen effect; the archived fact's own text comes back unchanged.
  const saveRestore = React.useCallback(() => {
    if (!restoring || !review || !draftCustody?.isCurrent()) return;
    if (!restoring.target.isCurrent()) {
      setNotice('refused');
      return;
    }
    const duplicateChoice = reviewedDuplicateChoice(review, choiceKind, candidateId);
    fireAndForget(
      (async () => {
        const { applied } = await settle(() => memoryDocumentActions.restore(
          restoring.target, restoring.fact.id, restoring.topic, undefined, duplicateChoice));
        if (applied) closeDraft();
      })(),
      { tag: 'MemoryDocumentBody.restoreWithChoice' },
    );
  }, [candidateId, choiceKind, closeDraft, draftCustody, restoring, review, settle]);

  const forget = React.useCallback(
    (fact: MemoryFactV1) => {
      if (!target) return;
      fireAndForget(
        (async () => {
          const { applied, target: restoreTarget } = await settle(async () => {
            const result = await memoryDocumentActions.forget(target, fact.id);
            // Only the accepted forget collapses the row, and before the refreshed view drops it.
            if (readMemoryActionOutcome(result) === 'applied') {
              const index = factsRef.current.findIndex((entry) => entry.id === fact.id);
              setCollapsing((list) => [
                ...list.filter((entry) => entry.fact.id !== fact.id),
                { fact, index: Math.max(0, index), settled: false },
              ]);
            }
            return result;
          });
          if (!applied) return;
          if (!restoreTarget) {
            setNotice('refused');
            return;
          }
          // The fact is already in the archive topic; Undo is offered on the app's one notice owner
          // (its lifetime, its place) and restores this exact fact to where it was.
          const key = `memory-forget:${fact.id}`;
          const restoreTopic = topic?.title;
          publishPresentationNotice({
            key,
            severity: 'info',
            message: t('memoryContext.memory.forgot'),
            undo: {
              label: t('memoryContext.memory.undo'),
              run: () => {
                retirePresentationNotice(key);
                if (!restoreTarget.isCurrent()) {
                  setNotice('refused');
                  return;
                }
                // Undo puts the row back in place: it stops leaving and returns with the restored view.
                setCollapsing((list) => list.filter((entry) => entry.fact.id !== fact.id));
                // A restore that needs a duplicate choice opens it in place, under this document's custody.
                setDraftCustody(draftCustodyRef.current);
                setRestoring({ fact, target: restoreTarget, ...(restoreTopic === undefined ? {} : { topic: restoreTopic }) });
                fireAndForget(
                  (async () => {
                    const { applied } = await settle(() => memoryDocumentActions.restore(restoreTarget, fact.id, restoreTopic));
                    if (applied) setRestoring(null);
                  })(),
                  { tag: 'MemoryDocumentBody.undoForget' },
                );
              },
            },
          });
        })(),
        { tag: 'MemoryDocumentBody.forget' },
      );
    },
    [settle, target, topic],
  );

  const settleCollapse = React.useCallback((factId: string) => {
    setCollapsing((list) =>
      list.flatMap((entry) =>
        entry.fact.id !== factId
          ? [entry]
          : factsRef.current.some((fact) => fact.id === factId)
            ? [{ ...entry, settled: true }]
            : [],
      ),
    );
  }, []);
  // A closed row whose fact has left the refreshed view is done.
  const viewFacts = view?.facts;
  React.useEffect(() => {
    setCollapsing((list) => {
      const next = list.filter((entry) => !entry.settled || (viewFacts ?? []).some((fact) => fact.id === entry.fact.id));
      return next.length === list.length ? list : next;
    });
  }, [viewFacts]);

  const startEdit = React.useCallback(
    (fact: MemoryFactV1) => {
      if (!source.draftCustody?.isCurrent()) return;
      onComposingChange(false);
      setRestoring(null);
      setReview(null);
      setViewingFactId(null);
      setDraftCustody(source.draftCustody);
      setEditingId(fact.id);
      setDraft(fact.text);
      setExpiryDraft(expiryDraftFor(fact, Date.now()));
    },
    [onComposingChange, source.draftCustody],
  );
  // A fact page's Edit lands here once its fact and an admitted version are on screen.
  const requestedEdit = React.useRef<string | null>(null);
  const editFact = props.editFactId ? orderedFacts.find((fact) => fact.id === props.editFactId) ?? null : null;
  // An expired fact read on the Archive page can still be renewed (its edit is the renewal).
  const canEdit = (writable || (!props.readOnly && editFact !== null && isMemoryFactRenewableV1(editFact, now)))
    && target !== null && Boolean(source.draftCustody?.isCurrent());
  React.useEffect(() => {
    if (!editFact || !canEdit || requestedEdit.current === editFact.id) return;
    requestedEdit.current = editFact.id;
    startEdit(editFact);
  }, [canEdit, editFact, startEdit]);

  const openTopic = React.useCallback(
    (title: string) => {
      if (!view) return;
      router.push(
        memoryDocumentHref(view.ref, { topic: title }) as never,
      );
    },
    [router, view],
  );
  const openAll = React.useCallback(() => {
    if (!view) return;
    router.push(
      memoryDocumentHref(view.ref) as never,
    );
  }, [router, view]);

  const status = source.status;
  const connection = useMemoryOffline(view?.ref.serverId ?? props.serverId);
  const facts = orderedFacts;
  const limit = props.collapsedFactCount;
  const shown =
    limit === undefined || facts.length <= limit
      ? facts
      : facts.slice(0, limit);
  const hiddenCount = facts.length - shown.length;
  const rows = mergeCollapsingFacts(shown, collapsing);
  const arrivedFactIds = useArrivedFactIds(
    view ? `${JSON.stringify(view.ref)}\u0000${topic?.title ?? ''}` : null,
    facts,
  );
  const topics = view?.topics ?? [];
  const editingFact = editingId ? facts.find((fact) => fact.id === editingId) ?? null : null;
  const renewing = editingFact !== null && isExpiredFact(editingFact, now);
  const viewing = review && review.candidates.some((entry) => entry.factId === viewingFactId) ? viewingFactId : null;
  const expiryOptions = React.useMemo(
    (): ReadonlyArray<SegmentedChoiceOption<Expiry>> => [
      { id: 'never', label: t('memoryContext.memory.sheetExpiresNever') },
      { id: 'date', label: t('memoryContext.memory.sheetExpiresOnDate') },
    ],
    [],
  );
  const draftForm = (
    <InlineAddExpander
      isOpen
      onOpenChange={() => {}}
      trigger={null}
      title={renewing ? t('memoryContext.memory.renew')
        : editingId ? t('common.edit') : t('memoryContext.memory.remember')}
      onCancel={closeDraft}
      onSave={save}
      saveDisabled={busy || draft.trim().length === 0 || (editingId !== null && resolveExpiry(expiryDraft) === undefined)}
      cancelLabel={t('common.cancel')}
      saveLabel={
        review ? duplicateSaveLabel(choiceKind)
          : renewing ? t('memoryContext.memory.renew')
            : editingId ? t('common.save') : t('memoryContext.memory.rememberSave')
      }
      autoFocusRef={draftRef}
      saveTestID={`${testID}.draft.save`}
      cancelTestID={`${testID}.draft.cancel`}
    >
      {review && viewing ? (
        <MemoryDuplicateSavedFact
          testID={`${testID}.draft.savedFact`}
          review={review}
          factId={viewing}
          serverId={view?.ref.serverId ?? serverId}
          viewerAccountId={target?.accountId ?? props.viewerAccountId ?? null}
          onBack={() => setViewingFactId(null)}
          onOpenSession={props.onOpenSession}
        />
      ) : null}
      {/* While a saved fact is open the draft stays mounted, so its text, caret and effect come back as left. */}
      <View style={viewing ? styles.hidden : null}>
        {review ? (
          <MemoryDuplicateChoice
            testID={`${testID}.draft.duplicate`}
            review={review}
            newText={draft}
            candidateId={candidateId}
            onCandidateChange={setCandidateId}
            choice={choiceKind}
            onChoiceChange={setChoiceKind}
            onViewCandidate={setViewingFactId}
            disabled={busy}
          />
        ) : null}
        <FieldTextInput
          ref={draftRef}
          testID={`${testID}.draft`}
          value={draft}
          onChangeText={changeDraft}
          accessibilityLabel={t('memoryContext.memory.remember')}
          placeholder={t('memoryContext.memory.rememberPlaceholder')}
          multiline
          minLines={2}
        />
        {!editingId && !topic ? (
          <FieldTextInput
            testID={`${testID}.draftTopic`}
            style={styles.topicField}
            value={draftTopic}
            onChangeText={changeDraftTopic}
            accessibilityLabel={t('memoryContext.memory.topicPlaceholder')}
            placeholder={t('memoryContext.memory.topicPlaceholder')}
            onSubmitEditing={save}
          />
        ) : null}
        {editingId && expiryDraft ? (
          <>
            <SegmentedChoiceItem<Expiry>
              title={t('memoryContext.memory.sheetExpires')}
              options={expiryOptions}
              value={expiryDraft.kind}
              onChange={(kind) => setExpiryDraft((current) => current && { ...current, kind })}
              testIDPrefix={`${testID}.draft.expiry`}
              accessoryLayout="adaptive"
              showDivider={false}
              // On the form's edge, like the fields above it.
              style={memoryDecisionSheetRowStyle}
              disabled={busy}
            />
            {expiryDraft.kind === 'date' ? (
              <LocalDateTimeEditor
                nowMs={expiryDraft.nowMs}
                value={expiryDraft.date}
                onChange={(date) => setExpiryDraft((current) => current && { ...current, date })}
                testIDPrefix={`${testID}.draft.expiresAt`}
                labels={{
                  date: t('memoryContext.memory.sheetExpiryDate'),
                  time: t('memoryContext.memory.sheetExpiryTime'),
                  pastInstant: t('memoryContext.memory.sheetExpiryPast'),
                }}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </InlineAddExpander>
  );

  const restoreForm = restoring && review ? (
    <InlineAddExpander
      isOpen
      onOpenChange={() => {}}
      trigger={null}
      title={t('memoryContext.memory.undo')}
      onCancel={closeDraft}
      onSave={saveRestore}
      saveDisabled={busy}
      cancelLabel={t('common.cancel')}
      saveLabel={duplicateSaveLabel(choiceKind)}
      saveTestID={`${testID}.restore.save`}
      cancelTestID={`${testID}.restore.cancel`}
    >
      <MemoryDuplicateChoice
        testID={`${testID}.restore.duplicate`}
        review={review}
        newText={restoring.fact.text}
        candidateId={candidateId}
        onCandidateChange={setCandidateId}
        choice={choiceKind}
        onChoiceChange={setChoiceKind}
        disabled={busy}
      />
    </InlineAddExpander>
  ) : null;

  const factRow = ({ fact, leaving }: Readonly<{ fact: MemoryFactV1; leaving: boolean }>) =>
        editingId === fact.id ? (
          <React.Fragment key={fact.id}>{draftForm}</React.Fragment>
        ) : (
          <MemoryFactSlot
            key={fact.id}
            testID={`${testID}.fact.${fact.id}.slot`}
            factId={fact.id}
            leaving={leaving}
            reducedMotion={reducedMotion}
            onCollapsed={settleCollapse}
          >
            <MemoryFactRow
              testID={`${testID}.fact.${fact.id}`}
              fact={fact}
              serverId={view?.ref.serverId ?? serverId}
              archived={archive}
              writable={writable && target !== null && !leaving}
              renewable={!props.readOnly && target !== null && !leaving && isMemoryFactRenewableV1(fact, now)}
              disabled={busy}
              arrived={arrivedFactIds.has(fact.id)}
              viewerAccountId={target?.accountId ?? props.viewerAccountId ?? null}
              onEdit={startEdit}
              onForget={forget}
              onOpenSession={props.onOpenSession}
              onOpenFact={props.onOpenFact}
              selected={props.selectedFactId === fact.id}
            />
          </MemoryFactSlot>
        );
  const leading = (
    <>
      <MemoryDocumentNotices testID={testID} offline={connection.offline} since={connection.since}
        source={source} notice={notice}
        onReviewConflict={conflictTarget ? () => showArtifactHistorySheet({
          commandBridge,
          artifactId: conflictTarget.ref.artifactId,
          name: view?.title,
          canRestore: false,
          compareFromBodyVersion: conflictTarget.expectedRevision.bodyVersion,
          client: createArtifactActionsClient({ serverId: conflictTarget.serverId, accountId: conflictTarget.accountId }),
        }) : undefined} />
      {/* A stale view keeps its facts; it has no counts to reserve a line for, so the line steps aside. */}
      {/* An open duplicate comparison is the one thing in progress; the count line steps aside until it closes. */}
      {/* A topic page counts its facts on its section title; only the index reports what agents load. */}
      {view && !topic && !connection.offline && (fresh || summary.state === 'ready') && !review ? (
        summary.state === 'unavailable' && fresh && summary.cause?.reason === 'machine_not_chosen' ? (
          <MemoryMachineChoice testID={`${testID}.machine`} invitation={t('memoryContext.memory.countsNeedMachine')} />
        ) : summary.state === 'unavailable' && fresh && summary.cause?.reason === 'not_in_use' ? (
          // Counts only mean something while the memory is in use; off, the slot says so and nothing looks broken.
          <Item
            testID={`${testID}.summaryOff`}
            mode="info"
            density="compact"
            showChevron={false}
            showDivider={false}
            title={<Text style={styles.summary}>{t('memoryContext.memory.countsOff')}</Text>}
          />
        ) : summary.state === 'unavailable' && fresh ? (
          <SurfaceStateCard
            testID={`${testID}.summaryUnavailable`}
            size="line"
            kind="error"
            title={t('memoryContext.memory.countsUnavailable')}
            action={{ label: t('common.retry'), onPress: () => fireAndForget(refresh(), { tag: 'MemoryDocumentBody.retrySummary' }) }}
          />
        ) : (
          <Item
            testID={`${testID}.summary`}
            mode="info"
            density="compact"
            showChevron={false}
            showDivider={false}
            title={summary.state === 'ready' ? (
              <Text style={styles.summary}>
                {`${t('memoryContext.memory.alwaysRemembered')} `}
                <Text style={styles.summaryValue}>
                  {/* Unknown is not zero: a count the machine does not report keeps its slot as a dash. */}
                  {summary.loadedFactCount !== undefined ? countLabel(summary.loadedFactCount) : '—'}
                </Text>
                {` · ${t('memoryContext.memory.searchable')} `}
                <Text style={styles.summaryValue}>{countLabel(summary.indexedFactCount)}</Text>
              </Text>
            ) : (
              // One reserved line the height of the summary, so the counts land without moving the facts.
              <View style={styles.summarySkeleton}>
                <HappierSkeletonBlock width={216} height={8} radius={4} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
              </View>
            )}
          />
        )
      ) : null}
      {restoreForm}
      {props.composing && !editingId && !restoring && writable && (target || canCreate) ? draftForm : null}
      {editingId && view && !rows.some(({ fact }) => fact.id === editingId) ? draftForm : null}
    </>
  );
  const trailing = (
    <>
      {/* An index with topics holds memory: it is not empty, so it never leads with the first-decision invitation. */}
      {view && facts.length === 0 && !props.composing && !(props.grouped && !topic && topics.length > 0) ? (
        props.renderEmpty ? props.renderEmpty({
          testID: `${testID}.empty`,
          text: topic ? t('memoryContext.memory.topicEmpty') : props.emptyText,
        }) : <Item
          testID={`${testID}.empty`}
          mode="info"
          showChevron={false}
          showDivider={topics.length > 0}
          title={topic ? t('memoryContext.memory.topicEmpty') : props.emptyText}
          titleStyle={styles.empty}
        />
      ) : null}
      {topics.map((entry) => (
        <Item
          key={entry.title}
          testID={`${testID}.topic.${entry.title}`}
          // A topic opens its own page, so it leads with its mark like every navigation row (lab `c-mem A`,
          // `c-ctx A`): a tag for a named topic, the archive box for the archive.
          icon={<Icon name={entry.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1 ? 'archive' : 'tag'} />}
          title={memoryTopicLabel(entry.title)}
          subtitle={
            entry.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1
              ? t('memoryContext.memory.archiveSummary')
              : entry.summary
          }
          subtitleLines={1}
          onPress={() => openTopic(entry.title)}
        />
      ))}
      {!view && status === 'loading' ? (
        // The sheet keeps its place while the document is read: the facts' rows are reserved, not a late strip.
        <ItemLoadStateRows
          testID={`${testID}.loading`}
          state={{ kind: 'loading' }}
          rows={3}
          lines={2}
          accessibilityLabel={t('common.loading')}
        />
      ) : !view && status === 'none' ? (
        props.composing && writable && canCreate ? null : props.renderEmpty ? props.renderEmpty({ testID: `${testID}.none`, text: props.emptyText }) : (
          <Item
            testID={`${testID}.none`}
            mode="info"
            showChevron={false}
            showDivider={false}
            title={props.emptyText}
            titleStyle={styles.empty}
          />
        )
      ) : !view &&
        (status === 'not_found' ||
          status === 'invalid' ||
          status === 'locked') ? (
        <Item
          testID={`${testID}.${status}`}
          icon={<Icon name={status === 'locked' ? 'lock' : 'warning'} />}
          showChevron={false}
          showDivider={false}
          title={
            status === 'locked'
              ? t('memoryContext.memory.locked')
              : status === 'not_found'
                ? t('memoryContext.memory.missing')
                : t('memoryContext.memory.invalid')
          }
        />
      ) : null}
      {view && props.footer ? (
        <Item
          testID={`${testID}.footer`}
          mode="info"
          density="compact"
          showChevron={false}
          showDivider={false}
          title={props.footer}
          titleLines={2}
          titleStyle={styles.footer}
        />
      ) : null}
    </>
  );
  if (!props.grouped || topic) {
    return (
      <>
        {leading}
        {rows.map(factRow)}
      {hiddenCount > 0 ? (
        <Item
          testID={`${testID}.showAll`}
          density="compact"
          showChevron={false}
          showDivider={false}
          title={t('memoryContext.memory.showAll', { count: facts.length })}
          titleStyle={styles.showAll}
          onPress={openAll}
        />
      ) : null}
        {trailing}
      </>
    );
  }
  // The index page: decisions, then notes, each its own counted section; expired facts fold away.
  const leadingForm = (props.composing && !editingId && !restoring && writable && Boolean(target || canCreate))
    || (restoring !== null && review !== null)
    || (editingId !== null && view !== null && !rows.some(({ fact }) => fact.id === editingId));
  // A fact being renewed stays in place while its form is open, even with expired facts folded away.
  const live = rows.filter(({ fact, leaving }) => leaving || !isExpiredFact(fact, now) || showExpired || fact.id === editingId);
  const expiredFacts = facts.filter((fact) => isExpiredFact(fact, now));
  const decisionRows = live.filter(({ fact }) => fact.decision !== undefined);
  const noteRows = live.filter(({ fact }) => fact.decision === undefined);
  return (
    <>
      {/* A form opened here is a sheet of its own; the lines above the facts stay flat. */}
      <ItemGroup header="none" surface={leadingForm ? undefined : 'none'}>{leading}</ItemGroup>
      {decisionRows.length > 0 ? (
        <ItemGroup
          testID={`${testID}.decisions`}
          title={t('memoryContext.memory.decisionsTitle')}
          titleAccessory={<ManagedSectionCount count={decisionRows.length} />}
          // Selection spans both sections: one fact of the page is open at a time.
          selectableItemCountOverride={live.length}
        >
          {decisionRows.map(factRow)}
        </ItemGroup>
      ) : null}
      {noteRows.length > 0 ? (
        <ItemGroup
          testID={`${testID}.notes`}
          title={t('memoryContext.memory.notesTitle')}
          titleAccessory={<ManagedSectionCount count={noteRows.length} />}
          selectableItemCountOverride={live.length}
        >
          {noteRows.map(factRow)}
        </ItemGroup>
      ) : null}
      <ItemGroup header="none" surface="none">
        {expiredFacts.length > 0 ? (
          <Item
            testID={`${testID}.expired`}
            mode="info"
            density="compact"
            showChevron={false}
            showDivider={false}
            icon={<Icon name="clock-counter-clockwise" />}
            title={expiredFacts.every((fact) => fact.decision !== undefined)
              ? t('memoryContext.memory.expiredDecisions', { count: expiredFacts.length })
              : t('memoryContext.memory.expiredFacts', { count: expiredFacts.length })}
            titleStyle={styles.footer}
            rightElement={(
              <HappierPressable
                testID={`${testID}.expired.toggle`}
                accessibilityRole="button"
                expanded={showExpired}
                onPress={() => setShowExpired((open) => !open)}
              >
                <Text style={styles.showAll}>{showExpired ? t('memoryContext.memory.hideExpired') : t('memoryContext.memory.showExpired')}</Text>
              </HappierPressable>
            )}
          />
        ) : null}
        {trailing}
      </ItemGroup>
    </>
  );
});

function ignoreExpandedChange() {}

/** The expiry to write: `null` for Never, a future instant for a date; `undefined` while the date is not one. */
function resolveExpiry(draft: ExpiryDraft | null): number | null | undefined {
  if (!draft || draft.kind === 'never') return null;
  return resolveHappierFutureLocalDateTime(draft.date, draft.nowMs) ?? undefined;
}

/** The reviewed effect bound to the exact revision it was reviewed at. */
function reviewedDuplicateChoice(review: DuplicateReview, kind: DuplicateChoiceKind, candidateId: string | null) {
  const factId = candidateId ?? leadingCandidateId(review);
  return kind === 'keep_both' || factId === null
    ? { kind: 'keep_both' as const, expectedRevision: review.revision }
    : { kind, factId, expectedRevision: review.revision };
}

function duplicateSaveLabel(choice: DuplicateChoiceKind): string {
  return choice === 'update' ? t('memoryContext.memory.duplicateSaveUpdate')
    : choice === 'replace' ? t('memoryContext.memory.duplicateSaveReplace')
      : t('memoryContext.memory.duplicateKeepBoth');
}

/**
 * The write owner found a saved fact like this one before saving anything (lab K2 `Sd`): the shared
 * plugin-ui comparison plugins draw too, bound to this review, the app's copy and its own controls.
 * The review, the effect's revision binding and the write stay here.
 */
export function MemoryDuplicateChoice(props: Readonly<{
  testID: string;
  review: DuplicateReview;
  /** What the person has typed now; the New line follows the draft. */
  newText: string;
  candidateId: string | null;
  onCandidateChange: (factId: string) => void;
  choice: DuplicateChoiceKind;
  onChoiceChange: (choice: DuplicateChoiceKind) => void;
  /** Opens the saved fact (its source, approval, history) in the same form. */
  onViewCandidate?: (factId: string) => void;
  disabled: boolean;
}>) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const candidates = React.useMemo(
    () => [...props.review.candidates]
      .sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1))
      .map((candidate) => ({
        id: candidate.factId,
        text: candidate.text,
        meta: [
          candidate.match === 'exact' ? t('memoryContext.memory.duplicateExact') : t('memoryContext.memory.duplicateRelated'),
          candidate.topic ? memoryTopicLabel(candidate.topic) : null,
          candidate.decision ? (candidate.decision.approvedBy ? t('memoryContext.memory.decision') : t('memoryContext.memory.decisionNotApproved')) : null,
        ].filter((part): part is string => Boolean(part)).join(' · '),
      })),
    [props.review.candidates],
  );
  return (
    <HappierMemoryDuplicateChoice
      testID={props.testID}
      candidates={candidates}
      newText={props.newText}
      candidateId={props.candidateId}
      onCandidateChange={props.onCandidateChange}
      choice={props.choice}
      onChoiceChange={props.onChoiceChange}
      onViewCandidate={props.onViewCandidate}
      disabled={props.disabled}
      labels={{
        title: candidates.length > 1
          ? t('memoryContext.memory.duplicateTitleMany', { count: candidates.length })
          : t('memoryContext.memory.duplicateTitle'),
        saved: t('memoryContext.memory.duplicateSaved'),
        new: t('memoryContext.memory.duplicateNew'),
        choice: t('memoryContext.memory.duplicateChoice'),
        options: {
          update: t('memoryContext.memory.duplicateUpdate'),
          replace: t('memoryContext.memory.duplicateReplace'),
          keep_both: t('memoryContext.memory.duplicateKeepBoth'),
        },
        effects: {
          update: t('memoryContext.memory.duplicateUpdateHint'),
          replace: t('memoryContext.memory.duplicateReplaceHint'),
          keep_both: t('memoryContext.memory.duplicateKeepBothHint'),
        },
        view: t('memoryContext.memory.duplicateView'),
      }}
      Text={DuplicateChoiceText}
      Choice={DuplicateChoiceControl}
      style={styles.duplicate}
      colors={{ chosen: theme.colors.surface.selected, hover: theme.colors.surface.hover }}
      radius={theme.borderRadius.md}
      space={theme.space}
    />
  );
}

function DuplicateChoiceText(props: HappierMemoryDuplicateChoiceTextProps) {
  const styles = stylesheet;
  const style = props.role === 'title' ? styles.duplicateTitle
    : props.role === 'action' ? styles.duplicateAction
    : props.role === 'label' ? styles.duplicateLabel
      : props.role === 'meta' ? styles.factMeta
        : props.role === 'effect' ? styles.duplicateEffect
          : [styles.duplicateText, props.retired ? styles.retired : null];
  return (
    <Text testID={props.testID} style={style} numberOfLines={props.numberOfLines} accessibilityRole={props.accessibilityRole}>
      {props.children}
    </Text>
  );
}

function DuplicateChoiceControl(props: HappierMemoryDuplicateChoiceControlProps) {
  return (
    <SegmentedTabBar<DuplicateChoiceKind>
      tabs={props.options}
      activeTabId={props.value}
      onSelectTab={props.onChange}
      segmentSizing="content"
      role="radiogroup"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      testIDPrefix={props.testIDPrefix}
    />
  );
}

/**
 * A fact's place in the list. Forgetting collapses its height and opacity together on the
 * disclosure owner's clock (lab `c-mem` Motion); reduced motion removes it at once.
 */
function MemoryFactSlot(
  props: Readonly<{
    testID: string;
    factId: string;
    leaving: boolean;
    reducedMotion: boolean;
    onCollapsed: (factId: string) => void;
    children: React.ReactNode;
  }>,
) {
  const { factId, onCollapsed } = props;
  const onSettled = React.useCallback(
    (expanded: boolean) => {
      if (!expanded) onCollapsed(factId);
    },
    [factId, onCollapsed],
  );
  return (
    <HappierDisclosure
      testID={props.testID}
      expanded={!props.leaving}
      onExpandedChange={ignoreExpandedChange}
      header={null}
      showDivider={false}
      reducedMotion={props.reducedMotion}
      motion={reanimatedDisclosureMotion}
      onSettled={onSettled}
    >
      {props.children}
    </HappierDisclosure>
  );
}

/** The soft wash a newly landed fact arrives with (lab `c-mem W`), fading on the compositor. */
function MemoryFactArrival(props: Readonly<{ testID: string; onDone: () => void }>) {
  const opacity = useSharedValue(1);
  const { onDone } = props;
  React.useEffect(() => {
    opacity.value = withTiming(0, { duration: motionTokens.durationMs.slow }, (finished) => {
      'worklet';
      if (finished) runOnJS(onDone)();
    });
  }, [onDone, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      testID={props.testID}
      pointerEvents="none"
      style={[stylesheet.arrival, style]}
    />
  );
}

/**
 * One remembered fact: the fact (two lines at most in a list), then one quiet line of date, expiry and
 * the Session it came from. "⋯" holds Edit, Forget and Open source; an archived fact is read-only.
 */
const MemoryFactRow = React.memo(function MemoryFactRow(
  props: Readonly<{
    testID: string;
    fact: MemoryFactV1;
    serverId: string;
    archived: boolean;
    writable: boolean;
    /** It has expired and this reader may renew it (also on the Archive page, where expired facts are read). */
    renewable: boolean;
    disabled: boolean;
    /** It landed while the list was on screen: it arrives with a soft wash that fades. */
    arrived: boolean;
    /** The Account reading this document, so its own approval reads "approved by you". */
    viewerAccountId: string | null;
    onEdit: (fact: MemoryFactV1) => void;
    onForget: (fact: MemoryFactV1) => void;
    onOpenSession?: (
      ref: Readonly<{ serverId: string; sessionId: string; messageId?: string }>,
    ) => void;
    onOpenFact?: (fact: MemoryFactV1) => void;
    selected?: boolean;
  }>,
) {
  const { fact, onEdit, onForget, onOpenSession, onOpenFact } = props;
  const [highlighting, setHighlighting] = React.useState(props.arrived);
  React.useEffect(() => {
    if (props.arrived) setHighlighting(true);
  }, [props.arrived]);
  const endHighlight = React.useCallback(() => setHighlighting(false), []);
  const decision = fact.decision;
  // A decision links the Session message it was decided in; a note links the Session it came from.
  const factSource = readMemoryFactSource(fact);
  const source = factSource?.kind === 'session'
    ? { ...factSource.session, ...(factSource.messageId ? { messageId: factSource.messageId } : {}) } : null;
  // A retained Session title is not current source admission. Detail reads its title on demand.
  const now = Date.now();
  const expired = fact.expiresAtMs !== undefined && fact.expiresAtMs <= now;
  const attribution = useMemoryFactAttribution(fact, props.serverId);
  // Rows sit under their Decisions or Notes section, which already says which kind each one is.
  const facts = [
    attribution.rowApproval,
    now - fact.createdAtMs < JUST_NOW_MS
      ? t('memoryContext.memory.justNow')
      : attribution.savedLabel,
    fact.expiresAtMs === undefined
      ? null
      : expired
        ? t('memoryContext.memory.expired', {
            date: formatMemoryDate(fact.expiresAtMs),
          })
        : t('memoryContext.memory.until', {
            date: formatMemoryDate(fact.expiresAtMs),
          }),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  // The qualified ref is enough to open the source; a second client may not have its title yet.
  const sourceLink = source && onOpenSession ? () => onOpenSession(source) : undefined;
  const actions = React.useMemo((): ItemAction[] => {
    const list: ItemAction[] = [];
    if (props.writable) {
      list.push({
        id: 'edit',
        title: t('common.edit'),
        icon: 'pencil',
        disabled: props.disabled,
        onPress: () => onEdit(fact),
      });
    }
    if (props.writable) {
      list.push({
        id: 'forget',
        title: t('memoryContext.memory.forget'),
        icon: 'trash',
        destructive: true,
        disabled: props.disabled,
        onPress: () => onForget(fact),
      });
    }
    return list;
  }, [fact, onEdit, onForget, props.disabled, props.writable]);
  return (
    <HappierMemoryFactRow
      testID={props.testID}
      text={fact.text}
      metadata={facts}
      detail={decision?.reason}
      source={source ? { label: t('memoryContext.memory.openSource'), accessibilityLabel: t('memoryContext.memory.openSource'), onPress: sourceLink } : undefined}
      archived={props.archived}
      expired={expired}
      onPress={onOpenFact ? () => onOpenFact(fact) : undefined}
      selected={props.selected}
      host={memoryFactHost}
      arrival={highlighting ? <MemoryFactArrival testID={`${props.testID}.arrived`} onDone={endHighlight} /> : null}
      actions={
        actions.length > 0 || props.renewable ? (
          <View style={stylesheet.rowActions}>
            {/* An expired fact names its one next step beside its menu (lab L9 expired: Renew). */}
            {props.renewable ? (
              <HappierPressable
                testID={`${props.testID}.renew`}
                accessibilityRole="button"
                disabled={props.disabled}
                onPress={() => onEdit(fact)}
              >
                <Text style={stylesheet.showAll}>{t('memoryContext.memory.renew')}</Text>
              </HappierPressable>
            ) : null}
            {actions.length > 0 ? (
              <ItemRowActions
                title={fact.text}
                actions={actions}
                overflowOnly
                overflowTriggerTestID={`${props.testID}.more`}
              />
            ) : null}
          </View>
        ) : undefined
      }
    />
  );
});

const memoryFactHost: HappierMemoryFactRowHost = {
  Row: function MemoryFactItem(props) {
    return <Item testID={props.testID} mode={props.onPress ? 'interactive' : 'info'} title={props.text}
      onPress={props.onPress} selected={props.selected}
      titleLines={props.archived ? undefined : 2}
      titleStyle={props.retired ? [stylesheet.factText, stylesheet.retired] : stylesheet.factText}
      subtitle={props.subtitle} subtitleLines={1} showChevron={false} rightElement={props.actions} />;
  },
  Metadata: function MemoryFactMetadata(props) {
    return <Text {...props} numberOfLines={1} style={stylesheet.factMeta} />;
  },
  Source: function MemoryFactSource(props) {
    return <Text {...props} style={stylesheet.factSource} />;
  },
  Detail: function MemoryFactDetail(props) {
    return <Text {...props} numberOfLines={2} style={stylesheet.factDetail} />;
  },
};

const stylesheet = StyleSheet.create((theme) => ({
  summary: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  summarySkeleton: {
    // The summary line's own height, so the counts replace the bar without moving the facts below.
    justifyContent: 'center',
    height: happierPageTextMetrics('meta').lineHeight,
  },
  summaryValue: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  showAll: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  empty: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.secondary,
  },
  footer: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  // A fact is content, not a row label: it reads in the regular face, as the lab's fact rows do.
  factText: {
    ...Typography.default(),
  },
  retired: {
    color: theme.colors.text.tertiary,
    textDecorationLine: 'line-through',
  },
  factMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  factDetail: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  factSource: {
    color: theme.colors.text.secondary,
  },
  topicField: {
    marginTop: theme.space.s8,
  },
  duplicate: {
    // One grouped comparison on the inset ground, its text on the form fields' edge (lab K2 `Sd`).
    marginBottom: theme.space.s12,
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s12,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
  },
  duplicateTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
  duplicateLabel: {
    // The label sits on the text's first line.
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    lineHeight: happierPageTextMetrics('rowTitle').lineHeight,
    color: theme.colors.text.tertiary,
  },
  duplicateText: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  duplicateAction: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  hidden: {
    display: 'none',
  },
  duplicateEffect: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  arrival: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.state.info.background,
  },
}));

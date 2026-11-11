import * as React from 'react';
import { resolveHappierFutureLocalDateTime, toHappierLocalDateTimeDraft, type HappierLocalDateTimeDraft } from '@happier-dev/plugin-ui/presentation';
import { MemoryDecisionSourceErrorCodeV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { useSessionSelector } from '@/sync/store/hooks';
import { memoryDocumentActions, readMemoryActionOutcome, readMemoryDuplicateReview, readMemoryCreationReceipt,
  readMemoryDecisionTargets, type MemoryCreationReceipt, type MemoryDecisionTarget } from '@/sync/ops/promptLibrary/memoryDocuments';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { leadingCandidateId, type DuplicateChoiceKind, type DuplicateReview } from './MemoryDocumentBody';
import type { SaveMemoryDecisionSeed } from './memoryDecisionSeed';
import { useMemoryCreationReceipt } from './useMemoryCreationReceipt';

type Notice = 'pending' | 'conflict' | 'refused' | 'disclosure' | 'sourceUnavailable' | 'saved_unattached' | null;
type Expiry = 'never' | 'date';
const NO_TARGETS: readonly MemoryDecisionTarget[] = Object.freeze([]);

function readSourceRefusal(errorCode: unknown): 'disclosure' | 'sourceUnavailable' | null {
  const code = MemoryDecisionSourceErrorCodeV1Schema.safeParse(errorCode);
  if (!code.success) return null;
  return code.data === 'memory_decision_disclosure_denied' ? 'disclosure'
    : code.data === 'memory_decision_source_unavailable' ? 'sourceUnavailable' : null;
}

/** The shared decision sheet's data owner; presentation consumes these same draft and receipt facts. */
export function useSaveMemoryDecision(props: Readonly<{
  seed: SaveMemoryDecisionSeed;
  onSaved: () => void;
  onCreatedMemory?: (receipt: MemoryCreationReceipt) => void;
}>) {
  const source = props.seed.sourceMessageRef;
  const sessionSource = source.kind === 'session' ? source.session : null;
  const serverId = sessionSource?.serverId ?? (source.kind === 'discussion' ? source.discussion.serverId : '');
  const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
  const homeIds = React.useMemo(() => [scopeId], [scopeId]);
  const binding = useServerCredentialAccountScopeBindings(homeIds).get(scopeId);
  const sessionId = sessionSource?.sessionId ?? '';
  const sessionMetadataVersion = useSessionSelector(sessionId, serverId, session => session?.metadataVersion ?? null);
  const ready = source.kind === 'discussion' || sessionMetadataVersion !== null;
  const [text, setText] = React.useState(props.seed.text);
  const [reason, setReason] = React.useState(props.seed.reason ?? '');
  const [expiry, setExpiry] = React.useState<Expiry>('never');
  const [nowMs] = React.useState(() => Date.now());
  const [expiryDraft, setExpiryDraft] = React.useState<HappierLocalDateTimeDraft>(() =>
    toHappierLocalDateTimeDraft(new Date(nowMs + 30 * 24 * 60 * 60 * 1000)));
  const [review, setReview] = React.useState<DuplicateReview | null>(null);
  const [choice, setChoice] = React.useState<DuplicateChoiceKind>('replace');
  const [candidateId, setCandidateId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [busy, setBusy] = React.useState(false);
  const { receipt: creationReceipt, onCreatedMemory: retainCreationReceipt } = useMemoryCreationReceipt({ serverId,
    scopeKey: JSON.stringify(source), attachedRef: null });
  const [controller] = React.useState(() => new AbortController());
  React.useEffect(() => () => controller.abort(), [controller]);
  const [storedTargets, setTargets] = React.useState<readonly MemoryDecisionTarget[]>([]);
  const [targetBinding, setTargetBinding] = React.useState<typeof binding>(undefined);
  const targets = targetBinding === binding && binding?.isCurrent() ? storedTargets : NO_TARGETS;
  const [targetStatus, setTargetStatus] = React.useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [targetCoverage, setTargetCoverage] = React.useState<'complete' | 'partial'>('complete');
  const [selectedTarget, setSelectedTarget] = React.useState<MemoryScopeTargetV1 | null>(null);
  const targetRead = React.useRef<Promise<void> | null>(null);
  const refreshTargets = React.useCallback((): Promise<void> => {
    if (targetRead.current) return targetRead.current;
    if (!binding?.isCurrent() || controller.signal.aborted) { setTargetStatus('unavailable'); return Promise.resolve(); }
    setTargetStatus('loading');
    const read = readMemoryDecisionTargets(serverId, controller.signal).then(result => {
      if (controller.signal.aborted || !binding.isCurrent()) return;
      setTargetBinding(binding);
      setTargets(result.targets);
      setTargetCoverage(result.coverage);
      setTargetStatus('ready');
    }).catch(() => { if (!controller.signal.aborted) setTargetStatus('unavailable'); })
      .finally(() => { if (targetRead.current === read) targetRead.current = null; });
    targetRead.current = read;
    return read;
  }, [binding, controller, serverId]);
  React.useEffect(() => {
    const retirement = binding?.onRetire(() => {
      controller.abort();
      setTargets([]);
      setTargetStatus('unavailable');
      setSelectedTarget(null);
      setReview(null);
      setText('');
      setReason('');
      setNotice('refused');
    });
    return () => retirement?.dispose();
  }, [binding, controller]);
  const selectTarget = React.useCallback((target: MemoryScopeTargetV1 | null) => {
    const eligible = target === null ? null : targets.find(row => sameTarget(row.target, target));
    if (controller.signal.aborted || busy || notice === 'pending' || creationReceipt || target !== null && !eligible) return;
    setSelectedTarget(eligible?.target ?? null);
    setReview(null);
    setCandidateId(null);
    setNotice(null);
  }, [busy, controller, creationReceipt, notice, targets]);
  // Null restores the existing Session/Account Action default, not a catalog-derived replacement.
  const clearTarget = React.useCallback(() => selectTarget(null), [selectTarget]);
  const expiresAtMs = expiry === 'date' ? resolveHappierFutureLocalDateTime(expiryDraft, nowMs) : null;
  const canSave = !busy && !controller.signal.aborted && binding?.isCurrent() === true && creationReceipt === null && notice !== 'pending' && text.trim().length > 0
    && reason.trim().length > 0 && (selectedTarget ? targetStatus === 'ready' && targets.some(row => sameTarget(row.target, selectedTarget)) : ready)
    && (expiry === 'never' || expiresAtMs !== null);

  const save = React.useCallback(async () => {
    if (!canSave) return;
    setBusy(true);
    setNotice(null);
    const choiceFactId = review ? (candidateId ?? leadingCandidateId(review)) : null;
    try {
      const draft = { text: text.trim(), reason: reason.trim(), sourceMessageRef: source,
        ...(expiresAtMs !== null ? { expiresAtMs } : {}),
        ...(review ? { reviewedTarget: { ref: review.ref, expectedRevision: review.revision },
          duplicateChoice: choice === 'keep_both' || choiceFactId === null
            ? { kind: 'keep_both' as const, expectedRevision: review.revision }
            : { kind: choice, factId: choiceFactId, expectedRevision: review.revision } } : {}),
      };
      const result = selectedTarget
        ? await memoryDocumentActions.saveDecisionInScope(selectedTarget, draft, serverId, controller.signal)
        : sessionSource !== null && sessionMetadataVersion !== null
        ? await memoryDocumentActions.saveDecisionInSession({ sessionId: sessionSource.sessionId, serverId: sessionSource.serverId,
          expectedMetadataRevision: sessionMetadataVersion }, draft, controller.signal)
        : await memoryDocumentActions.saveDecisionInScope({ scope: 'account' }, draft, serverId, controller.signal);
      if (controller.signal.aborted) return;
      const found = readMemoryDuplicateReview(result);
      if (found) { setReview(found); setCandidateId(leadingCandidateId(found)); return; }
      const outcome = readMemoryActionOutcome(result);
      const sourceRefusal = result.ok ? null : readSourceRefusal(result.errorCode);
      if (sourceRefusal) { setNotice(sourceRefusal); return; }
      const receipt = readMemoryCreationReceipt(result);
      if (receipt) { retainCreationReceipt(receipt); props.onCreatedMemory?.(receipt); }
      if (outcome === 'applied') props.onSaved();
      else setNotice(outcome === 'review' ? null : outcome);
    } catch (error) {
      if (!controller.signal.aborted) setNotice(readSourceRefusal(
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined) ?? 'refused');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [canSave, candidateId, choice, controller, expiresAtMs, props, reason, retainCreationReceipt, review, selectedTarget, serverId, sessionMetadataVersion, sessionSource, source, text]);

  return { text, setText, reason, setReason, expiry, setExpiry, nowMs, expiryDraft, setExpiryDraft,
    review, choice, setChoice, candidateId, setCandidateId, notice, busy, canSave, save, creationReceipt, sessionSource,
    targets, targetStatus, targetCoverage, selectedTarget, selectTarget, clearTarget, refreshTargets };
}

function sameTarget(a: MemoryScopeTargetV1, b: MemoryScopeTargetV1) {
  return a.scope === b.scope && (a.scope === 'account' || b.scope === 'project'
    && a.projectRef.serverId === b.projectRef.serverId && a.projectRef.projectKey === b.projectRef.projectKey);
}

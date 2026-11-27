import * as React from 'react';
import { usePluginTranslation, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageEvidenceDisclosure, type TriageSourcePanelCommandV1, type TriageSourcePanelHandlerV1 } from './evidenceDisclosure.js';
import { triageSourcePanelIntentKeyV1, type TriageSourcePanelIntentV1, type TriageSourcePanelOperationV1, type TriageSourcePanelResultV1 } from './sourcePanelProtocol.js';

/** Registers the incumbent panel owner, only during its real active interval. */
export function useTriageSourcePanelIntentV1(
  intent: TriageSourcePanelIntentV1,
  invoke: TriageSourcePanelHandlerV1,
  commands: readonly TriageSourcePanelCommandV1[],
  enabled = true,
) {
  const { panelActions } = useTriageEvidenceDisclosure();
  const { active, activeSignal } = useTabPanelActivity();
  const key = triageSourcePanelIntentKeyV1(intent);
  const latest = React.useRef(invoke);
  React.useLayoutEffect(() => { latest.current = invoke; }, [invoke]);
  React.useLayoutEffect(() => !active || !enabled ? undefined : panelActions?.bind(key,
    (operation, signal) => latest.current(operation, signal), commands), [active, commands, enabled, key, panelActions]);
  return React.useCallback(async (operation: TriageSourcePanelOperationV1): Promise<TriageSourcePanelResultV1> => {
    if (!active || !enabled || activeSignal.aborted || panelActions === undefined) return { status: 'unavailable' };
    return await panelActions.execute(operation, activeSignal);
  }, [active, activeSignal, enabled, panelActions]);
}

/** The visible continuation and the mounted command advance the same source-owned walk. */
export function useTriageSourcePanelPagingV1(
  list: string,
  title: string,
  canLoadMore: boolean,
  pending: boolean,
  onLoadMore: () => void,
  enabled = true,
): () => void {
  const commands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => canLoadMore && !pending
    ? [{ title, operation: { kind: 'loadMoreSourceItems', list } }] : [], [canLoadMore, list, pending, title]);
  const advance = React.useCallback((): TriageSourcePanelResultV1 => {
    if (!canLoadMore || pending) return { status: 'unavailable' };
    onLoadMore();
    return { status: 'applied' };
  }, [canLoadMore, onLoadMore, pending]);
  useTriageSourcePanelIntentV1({ kind: 'loadMoreSourceItems', list }, async () => advance(), commands, enabled);
  return React.useCallback(() => { advance(); }, [advance]);
}

const noPublicationContinuation = () => {};

type PublicationDraftFinding = Readonly<{ id: string; title: string }>;

function withFinding(ids: readonly string[], proposalId: string, included: boolean): readonly string[] {
  return included ? [...ids.filter((id) => id !== proposalId), proposalId] : ids.filter((id) => id !== proposalId);
}

/** Mounted commands and visible controls edit the same forge-owned draft. */
export function useTriageReviewPublicationDraftV1<Verdict extends string>(options: Readonly<{
  open?: boolean;
  selection?: Readonly<{
    findings: readonly PublicationDraftFinding[];
    selectedIds: readonly string[];
    setSelectedIds: (ids: readonly string[]) => void;
  }>;
  continuation?: Readonly<{ title: string; pending: boolean; loadMore?: () => void }>;
  walkthrough?: Readonly<{ included: boolean; setIncluded: (included: boolean) => void }> | null;
  verdictOptions: readonly Readonly<{ value: Verdict; label: string }>[];
  setVerdict: (verdict: Verdict) => void;
  setSummary: (summary: string) => void;
}>) {
  const text = usePluginTranslation();
  const { open = true, continuation, selection, walkthrough, verdictOptions, setVerdict, setSummary } = options;
  const loadMore = useTriageSourcePanelPagingV1(
    'publication-proposals',
    continuation?.title ?? '',
    continuation?.loadMore !== undefined,
    continuation?.pending === true,
    continuation?.loadMore ?? noPublicationContinuation,
    open && continuation?.loadMore !== undefined,
  );
  const setFinding = React.useCallback((proposalId: string, included: boolean): TriageSourcePanelResultV1 => {
    if (!selection?.findings.some((finding) => finding.id === proposalId)) return { status: 'unavailable' };
    selection.setSelectedIds(withFinding(selection.selectedIds, proposalId, included));
    return { status: 'applied' };
  }, [selection]);
  const setWalkthrough = React.useCallback((included: boolean): TriageSourcePanelResultV1 => {
    if (walkthrough == null) return { status: 'unavailable' };
    walkthrough.setIncluded(included);
    return { status: 'applied' };
  }, [walkthrough]);
  const changeVerdict = React.useCallback((value: string): TriageSourcePanelResultV1 => {
    const choice = verdictOptions.find((option) => option.value === value);
    if (choice === undefined) return { status: 'rejected' };
    setVerdict(choice.value);
    return { status: 'applied' };
  }, [setVerdict, verdictOptions]);
  const findingCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => selection?.findings.map((finding) => {
    const included = selection.selectedIds.includes(finding.id);
    return {
      title: included
        ? text('plugins.triage.publication.leaveOutFinding', 'Leave out \u201c{title}\u201d', { title: finding.title })
        : text('plugins.triage.publication.postFinding', 'Post \u201c{title}\u201d', { title: finding.title }),
      operation: { kind: 'setPublicationFindingIncluded', proposalId: finding.id, included: !included },
    };
  }) ?? [], [selection, text]);
  const walkthroughCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => walkthrough == null ? [] : [{
    title: walkthrough.included
      ? text('plugins.triage.publication.leaveOutWalkthrough', 'Leave out the walkthrough')
      : text('plugins.triage.publication.includeWalkthrough', 'Include the walkthrough'),
    operation: { kind: 'setPublicationWalkthroughIncluded', included: !walkthrough.included },
  }], [text, walkthrough]);
  const verdictCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => verdictOptions.map(({ value, label }) => ({
    title: text('plugins.triage.publication.setVerdict', 'Set review type to {verdict}', { verdict: label }),
    operation: { kind: 'setPublicationVerdict', verdict: value },
  })), [text, verdictOptions]);
  const summaryCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => [{
    title: text('plugins.triage.publication.clearSummary', 'Clear the review summary'),
    operation: { kind: 'setPublicationSummary', summary: '' },
  }], [text]);
  useTriageSourcePanelIntentV1('setPublicationFindingIncluded', async (operation) =>
    operation.kind === 'setPublicationFindingIncluded' ? setFinding(operation.proposalId, operation.included) : { status: 'rejected' },
  findingCommands, open && selection !== undefined);
  useTriageSourcePanelIntentV1('setPublicationWalkthroughIncluded', async (operation) =>
    operation.kind === 'setPublicationWalkthroughIncluded' ? setWalkthrough(operation.included) : { status: 'rejected' },
  walkthroughCommands, open && walkthrough != null);
  useTriageSourcePanelIntentV1('setPublicationVerdict', async (operation) =>
    operation.kind === 'setPublicationVerdict' ? changeVerdict(operation.verdict) : { status: 'rejected' },
  verdictCommands, open);
  useTriageSourcePanelIntentV1('setPublicationSummary', async (operation) => {
    if (operation.kind !== 'setPublicationSummary') return { status: 'rejected' };
    setSummary(operation.summary);
    return { status: 'applied' };
  }, summaryCommands, open);
  // The sheet's own checklist reports a whole selection; each changed finding goes through the command's change.
  const setSelectedFromSheet = React.useCallback((ids: readonly string[]) => {
    if (selection === undefined) return;
    const { findings, selectedIds, setSelectedIds } = selection;
    let next = selectedIds;
    for (const finding of findings) {
      const included = ids.includes(finding.id);
      if (included !== next.includes(finding.id)) next = withFinding(next, finding.id, included);
    }
    if (next !== selectedIds) setSelectedIds(next);
  }, [selection]);
  const setWalkthroughFromSheet = React.useCallback((included: boolean) => { setWalkthrough(included); }, [setWalkthrough]);
  return { loadMore: continuation?.loadMore === undefined ? undefined : loadMore, setSelectedIds: setSelectedFromSheet, setWalkthroughIncluded: setWalkthroughFromSheet, setVerdict: changeVerdict };
}

import * as React from 'react';
import { usePluginTranslation, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageEvidenceDisclosure, type TriageSourcePanelCommandV1, type TriageSourcePanelHandlerV1 } from './evidenceDisclosure.js';
import { triageSourcePanelIntentKeyV1, type TriageSourcePanelIntentV1, type TriageSourcePanelOperationV1, type TriageSourcePanelResultV1 } from './sourcePanelProtocol.js';

/** Registers the incumbent panel owner, only during its real active interval. */
export function useTriageSourcePanelIntentV1(
  intent: TriageSourcePanelIntentV1,
  invoke: TriageSourcePanelHandlerV1,
  commands: readonly TriageSourcePanelCommandV1[],
) {
  const { panelActions } = useTriageEvidenceDisclosure();
  const { active, activeSignal } = useTabPanelActivity();
  const key = triageSourcePanelIntentKeyV1(intent);
  const latest = React.useRef(invoke);
  React.useLayoutEffect(() => { latest.current = invoke; }, [invoke]);
  React.useLayoutEffect(() => !active ? undefined : panelActions?.bind(key,
    (operation, signal) => latest.current(operation, signal), commands), [active, commands, key, panelActions]);
  return React.useCallback(async (operation: TriageSourcePanelOperationV1): Promise<TriageSourcePanelResultV1> => {
    if (!active || activeSignal.aborted || panelActions === undefined) return { status: 'unavailable' };
    return await panelActions.execute(operation, activeSignal);
  }, [active, activeSignal, panelActions]);
}

/** The visible continuation and the mounted command advance the same source-owned walk. */
export function useTriageSourcePanelPagingV1(
  list: string,
  title: string,
  canLoadMore: boolean,
  pending: boolean,
  onLoadMore: () => void,
): () => void {
  const commands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => canLoadMore && !pending
    ? [{ title, operation: { kind: 'loadMoreSourceItems', list } }] : [], [canLoadMore, list, pending, title]);
  const advance = React.useCallback((): TriageSourcePanelResultV1 => {
    if (!canLoadMore || pending) return { status: 'unavailable' };
    onLoadMore();
    return { status: 'applied' };
  }, [canLoadMore, onLoadMore, pending]);
  useTriageSourcePanelIntentV1({ kind: 'loadMoreSourceItems', list }, async () => advance(), commands);
  return React.useCallback(() => { advance(); }, [advance]);
}

type PublicationDraftFinding = Readonly<{ id: string; title: string }>;

function withFinding(ids: readonly string[], proposalId: string, included: boolean): readonly string[] {
  return included ? [...ids.filter((id) => id !== proposalId), proposalId] : ids.filter((id) => id !== proposalId);
}

/**
 * The open Publish sheet's draft, operable from its checklist and switch and from the mounted commands alike: both
 * apply the same change to the forge's one selection and walkthrough choice, so an agent edits the draft the
 * person sees before either publishes it.
 */
export function useTriageReviewPublicationDraftV1(options: Readonly<{
  findings: readonly PublicationDraftFinding[];
  selectedIds: readonly string[];
  setSelectedIds: (ids: readonly string[]) => void;
  walkthrough: Readonly<{ included: boolean; setIncluded: (included: boolean) => void }> | null;
}>): Readonly<{ setSelectedIds: (ids: readonly string[]) => void; setWalkthroughIncluded: (included: boolean) => void }> {
  const text = usePluginTranslation();
  const { findings, selectedIds, setSelectedIds, walkthrough } = options;
  const setFinding = React.useCallback((proposalId: string, included: boolean): TriageSourcePanelResultV1 => {
    if (!findings.some((finding) => finding.id === proposalId)) return { status: 'unavailable' };
    setSelectedIds(withFinding(selectedIds, proposalId, included));
    return { status: 'applied' };
  }, [findings, selectedIds, setSelectedIds]);
  const setWalkthrough = React.useCallback((included: boolean): TriageSourcePanelResultV1 => {
    if (walkthrough === null) return { status: 'unavailable' };
    walkthrough.setIncluded(included);
    return { status: 'applied' };
  }, [walkthrough]);
  const findingCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => findings.map((finding) => {
    const included = selectedIds.includes(finding.id);
    return {
      title: included
        ? text('plugins.triage.publication.leaveOutFinding', 'Leave out \u201c{title}\u201d', { title: finding.title })
        : text('plugins.triage.publication.postFinding', 'Post \u201c{title}\u201d', { title: finding.title }),
      operation: { kind: 'setPublicationFindingIncluded', proposalId: finding.id, included: !included },
    };
  }), [findings, selectedIds, text]);
  const walkthroughCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => walkthrough === null ? [] : [{
    title: walkthrough.included
      ? text('plugins.triage.publication.leaveOutWalkthrough', 'Leave out the walkthrough')
      : text('plugins.triage.publication.includeWalkthrough', 'Include the walkthrough'),
    operation: { kind: 'setPublicationWalkthroughIncluded', included: !walkthrough.included },
  }], [text, walkthrough]);
  useTriageSourcePanelIntentV1('setPublicationFindingIncluded', async (operation) =>
    operation.kind === 'setPublicationFindingIncluded' ? setFinding(operation.proposalId, operation.included) : { status: 'rejected' },
  findingCommands);
  useTriageSourcePanelIntentV1('setPublicationWalkthroughIncluded', async (operation) =>
    operation.kind === 'setPublicationWalkthroughIncluded' ? setWalkthrough(operation.included) : { status: 'rejected' },
  walkthroughCommands);
  // The sheet's own checklist reports a whole selection; each changed finding goes through the command's change.
  const setSelectedFromSheet = React.useCallback((ids: readonly string[]) => {
    let next = selectedIds;
    for (const finding of findings) {
      const included = ids.includes(finding.id);
      if (included !== next.includes(finding.id)) next = withFinding(next, finding.id, included);
    }
    if (next !== selectedIds) setSelectedIds(next);
  }, [findings, selectedIds, setSelectedIds]);
  const setWalkthroughFromSheet = React.useCallback((included: boolean) => { setWalkthrough(included); }, [setWalkthrough]);
  return { setSelectedIds: setSelectedFromSheet, setWalkthroughIncluded: setWalkthroughFromSheet };
}

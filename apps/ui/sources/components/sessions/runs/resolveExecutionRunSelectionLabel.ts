import { isSessionModelRefSourceBound, readSessionModelRefProviderConnectionId } from '@happier-dev/protocol/providers/selection/v2';
import type { ExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';

import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ScmDiffSummaryCatalogProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { t } from '@/text';

const PROVENANCE_KEY = {
  inherited: 'runPage.menu.selectionInherited',
  explicit: 'runPage.menu.selectionExplicit',
  independent: 'runPage.menu.selectionIndependent',
  retained: 'runPage.menu.selectionRetained',
} as const satisfies Record<ExecutionRunResolvedSelection['source'], string>;

export type RunNativeModelCatalog = readonly Pick<ScmDiffSummaryCatalogProfile, 'title' | 'modelSelector'>[];

/**
 * Where a Run's model came from and what it runs through, from the host's resolved launch record
 * (plan R2/D9): "Inherit session · DeepSeek · deepseek-v4", "Chosen for this run · …". The route is
 * named from the recorded route's recipient-safe display facts; nothing is guessed.
 */
export function resolveExecutionRunSelectionLabel(
  selection: ExecutionRunResolvedSelection | undefined,
  connectionLabel: (connectionId: string) => string | null,
  /** Display only, from the canonical Connected/Team route presenter for this resolved selection. */
  resolvedSourceLabel?: string | null,
  /** The Agent catalog's title for one of its own models; a Provider or Team model id is already its name. */
  nativeModelLabel?: (modelId: string) => string | null,
): string | null {
  if (!selection) return null;
  const connectionId = selection.modelSelection ? readSessionModelRefProviderConnectionId(selection.modelSelection) : null;
  const nativeModelId = connectionId || selection.teamCredentialModel
    ? null
    : selection.modelSelection?.modelId ?? selection.modelId ?? null;
  const model =
    (nativeModelId ? nativeModelLabel?.(nativeModelId) : null) ??
    selection.modelSelection?.modelId ??
    selection.teamCredentialModel?.modelId ??
    selection.modelId ??
    null;
  return [
    t(PROVENANCE_KEY[selection.source]),
    connectionId ? connectionLabel(connectionId) : resolvedSourceLabel,
    model,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/**
 * The native-model title resolver for a Run's recorded Agent. Callers pass the catalog already
 * admitted for that Run's Home and Machine; only its exact Agent target may name the model.
 * A recorded Session/static title wins; catalog discovery fills only a missing name.
 */
/** The model a Run records, from its resolved launch selection, else what was requested. */
export function readExecutionRunModelId(run: Readonly<{
  resolvedSelection?: ExecutionRunResolvedSelection | null;
  requestedConfiguration?: Readonly<{ modelId?: string | null }> | null;
}>): string | null {
  return (run.resolvedSelection?.modelSelection?.modelId
    ?? run.resolvedSelection?.teamCredentialModel?.modelId
    ?? run.resolvedSelection?.modelId
    ?? run.requestedConfiguration?.modelId)?.trim() || null;
}

/** Who answers a Run conversation, as its header and its composer's fixed engine chip name it. */
export type RunAnsweringEngine = Readonly<{ label: string; agentId: string | undefined }>;

/** A Session's own model list: it may name a Run's model only when the Run runs that same Agent. */
export type RunSessionModels = Readonly<{ agentId: string; metadata: ComposerOptionsInputV1 | null | undefined }>;

export function resolveRunAnsweringEngine(params: Readonly<{
  backendTarget: BackendTargetRefV2Input | null | undefined;
  selection?: Pick<ExecutionRunResolvedSelection, 'modelSelection' | 'teamCredentialModel'>;
  modelId: string | null | undefined;
  catalogProfiles?: RunNativeModelCatalog;
  sessionModels?: RunSessionModels;
}>): RunAnsweringEngine | null {
  const modelId = params.modelId?.trim();
  if (!modelId) return null;
  let agentId: string | undefined;
  try {
    const target = params.backendTarget ? readBackendTargetRefV2(params.backendTarget) : null;
    agentId = target && !target.configuredBackendId ? target.backendId : undefined;
  } catch {
    agentId = undefined;
  }
  return {
    label: resolveRunNativeModelLabel(params.backendTarget, params.catalogProfiles, params.selection, params.sessionModels)(modelId) ?? modelId,
    agentId,
  };
}

export function resolveRunNativeModelLabel(
  backendTarget: BackendTargetRefV2Input | null | undefined,
  catalogProfiles?: RunNativeModelCatalog,
  selection?: Pick<ExecutionRunResolvedSelection, 'modelSelection' | 'teamCredentialModel'>,
  sessionModels?: RunSessionModels,
) {
  let agentId: string | null = null;
  let targetKey: string | null = null;
  try {
    const target = backendTarget ? readBackendTargetRefV2(backendTarget) : null;
    targetKey = target ? buildBackendTargetKeyV2(target) : null;
    agentId = target && !target.configuredBackendId ? target.backendId : null;
  } catch {
    agentId = null;
  }
  return (modelId: string): string | null => {
    if ((selection?.modelSelection && isSessionModelRefSourceBound(selection.modelSelection)) || selection?.teamCredentialModel) return null;
    const observed = targetKey ? catalogProfiles?.find(profile => profile.modelSelector?.backendTargetKey === targetKey
      && profile.modelSelector.modelId === modelId) : null;
    const recorded = agentId && isBundledAgentId(agentId)
      ? resolveSessionModelLabel(agentId, sessionModels?.agentId === agentId ? sessionModels.metadata : null, modelId)
      : null;
    // A recorded title is already available to every surface; catalog arrival must not rename it.
    return (recorded && recorded !== modelId ? recorded : null) || observed?.title.trim() || recorded;
  };
}

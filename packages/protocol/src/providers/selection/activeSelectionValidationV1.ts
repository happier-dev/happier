import {
  readSessionProviderBindingMetadataStateV1,
  sessionProviderBindingMetadataMatchesRuntimeBasisV1,
} from '../sessions/bindingMetadataV1.js';
import {
  SessionActiveModelSelectionV1Schema,
  type SessionActiveModelSelectionV1,
} from './v1.js';

export function readExactSessionActiveModelSelectionV1(params: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null | undefined;
  agentId: string;
  agentTargetKey: string;
  currentRunnerProcessIdentity: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null;
}>): SessionActiveModelSelectionV1 | null {
  const metadata = params.metadata;
  if (!metadata) return null;
  const catalog = metadata.sessionModelsV1;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return null;
  }
  const catalogRecord = catalog as Record<string, unknown>;
  if (
    catalogRecord.agentId !== params.agentId
    || typeof catalogRecord.currentModelId !== 'string'
    || !Array.isArray(catalogRecord.availableModels)
  ) {
    return null;
  }
  const active = SessionActiveModelSelectionV1Schema.safeParse(
    catalogRecord.activeSelectionV1,
  );
  if (
    !active.success
    || active.data.selection.agentTargetKey !== params.agentTargetKey
    || active.data.selection.modelId !== catalogRecord.currentModelId
    || !catalogRecord.availableModels.some((model) => (
      model !== null
      && typeof model === 'object'
      && !Array.isArray(model)
      && (model as Record<string, unknown>).id === active.data.selection.modelId
    ))
  ) {
    return null;
  }

  const currentRunner = params.currentRunnerProcessIdentity;
  if (
    currentRunner === null
    || currentRunner.pid !== active.data.runner.pid
    || currentRunner.processStartTimeMs
      !== active.data.runner.processStartTimeMs
  ) {
    return null;
  }

  const bindingState = readSessionProviderBindingMetadataStateV1(metadata);
  const selection = active.data.selection;
  if (selection.providerConnectionId === null) {
    return bindingState.kind === 'absent' ? active.data : null;
  }
  if (bindingState.kind !== 'valid') return null;
  const binding = bindingState.binding;
  if (
    binding.connectionId !== selection.providerConnectionId
    || binding.model?.id !== selection.modelId
    || !sessionProviderBindingMetadataMatchesRuntimeBasisV1({
      selection,
      binding,
    })
  ) {
    return null;
  }
  return active.data;
}

import {
  readSessionProviderBindingMetadataStateV1,
  sessionProviderBindingMetadataMatchesRuntimeBasisV1,
} from '../sessions/bindingMetadataV1.js';
import type { SessionActiveModelSelectionV1 } from './v1.js';
import { SessionActiveModelSelectionSchema, type SessionActiveModelSelection } from './v2.js';

export function readExactSessionActiveModelSelection(params: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null | undefined;
  agentId: string;
  agentTargetKey: string;
  currentRunnerProcessIdentity: Readonly<{
    pid: number;
    processStartTimeMs: number;
  }> | null;
}>): SessionActiveModelSelection | null {
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
  // Catalog confidence controls selectable rows, not evidence from an admitted
  // runner. Private Provider catalogs may be empty after a successful model open.
  const active = SessionActiveModelSelectionSchema.safeParse(
    catalogRecord.activeSelectionV1,
  );
  if (
    !active.success
    || active.data.selection.agentTargetKey !== params.agentTargetKey
    || active.data.selection.modelId !== catalogRecord.currentModelId
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

/** V1 readers accept only the sources its model tuple can represent. */
export function readExactSessionActiveModelSelectionV1(
  params: Parameters<typeof readExactSessionActiveModelSelection>[0],
): SessionActiveModelSelectionV1 | null {
  const fact = readExactSessionActiveModelSelection(params);
  return fact?.v === 1 ? fact : null;
}

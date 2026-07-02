import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type {
  CatalogAgentId,
  ConnectedServiceResumeContinuityDiagnostics,
} from '@/backends/types';
import {
  REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
  verifyResumeReachabilityByAgent,
} from '@/backends/connectedServices/verifyResumeReachabilityByAgent';

import {
  readConnectedServiceStateSharingManifest,
  type ConnectedServiceStateSharingManifestV1,
} from './connectedServiceStateSharingManifest';

type StateMode = 'shared' | 'isolated';
type ReachabilitySource = 'persisted_file' | 'manifest_cache_validated' | 'provider_search';

export type CanResumeFromMaterializedStateInput = Readonly<{
  agentId: CatalogAgentId;
  serviceId: string;
  targetMaterializedRoot: string;
  targetMaterializedEnv: Readonly<Record<string, string>>;
  effectiveStateMode: StateMode;
  requestedStateMode: StateMode;
  materializationIdentity: Readonly<{ v: 1; id: string }>;
  vendorResumeId: string;
  cwd: string;
  candidatePersistedSessionFile?: string | null;
  manifest?: ConnectedServiceStateSharingManifestV1 | null;
}>;

export type CanResumeFromMaterializedStateResult =
  | Readonly<{
      ok: true;
      resolvedPath: string | null;
      effectiveStateMode: StateMode;
      source: ReachabilitySource;
      checkedAtMs: number;
    }>
  | Readonly<{
      ok: false;
      reason: string;
      diagnostics: readonly string[];
      continuityDiagnostics: ConnectedServiceResumeContinuityDiagnostics;
      checkedAtMs: number;
    }>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function statFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function toResultOk(input: Readonly<{
  source: ReachabilitySource;
  resolvedPath: string | null;
  effectiveStateMode: StateMode;
}>): CanResumeFromMaterializedStateResult {
  return {
    ok: true,
    source: input.source,
    resolvedPath: input.resolvedPath,
    effectiveStateMode: input.effectiveStateMode,
    checkedAtMs: Date.now(),
  };
}

function toResultFail(input: Readonly<{
  reason: string;
  continuityDiagnostics: ConnectedServiceResumeContinuityDiagnostics;
  diagnostics?: readonly string[];
}>): CanResumeFromMaterializedStateResult {
  return {
    ok: false,
    reason: input.reason,
    diagnostics: input.diagnostics ?? [],
    continuityDiagnostics: input.continuityDiagnostics,
    checkedAtMs: Date.now(),
  };
}

function resolveManifestCandidatePath(input: Readonly<{
  root: string;
  destinationPath: string;
}>): string {
  return isAbsolute(input.destinationPath)
    ? input.destinationPath
    : join(input.root, input.destinationPath);
}

async function resolveProviderReachability(
  input: CanResumeFromMaterializedStateInput,
): Promise<Readonly<{ ok: true; resolvedPath: string | null }> | Readonly<{ ok: false; reason: string }>> {
  const providerInput = {
    targetMaterializedRoot: input.targetMaterializedRoot,
    targetMaterializedEnv: input.targetMaterializedEnv,
    vendorResumeId: input.vendorResumeId,
    cwd: input.cwd,
    candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
  };

  return await verifyResumeReachabilityByAgent({
    agentId: input.agentId,
    input: providerInput,
  });
}

export async function canResumeFromMaterializedState(
  input: CanResumeFromMaterializedStateInput,
): Promise<CanResumeFromMaterializedStateResult> {
  const candidatePersistedSessionFile = asNonEmptyString(input.candidatePersistedSessionFile);
  const manifest = input.manifest ?? await readConnectedServiceStateSharingManifest(input.targetMaterializedRoot);
  const diagnostics = manifest.diagnostics;
  for (const mapping of manifest.sessionFileMappings) {
    if (mapping.vendorResumeId !== input.vendorResumeId) continue;
    const candidatePath = resolveManifestCandidatePath({
      root: input.targetMaterializedRoot,
      destinationPath: mapping.destinationPath,
    });
    if (!await statFile(candidatePath)) continue;
    return toResultOk({
      source: 'manifest_cache_validated',
      resolvedPath: candidatePath,
      effectiveStateMode: input.effectiveStateMode,
    });
  }

  const providerReachability = await resolveProviderReachability(input);
  if (providerReachability.ok) {
    return toResultOk({
      source: candidatePersistedSessionFile && providerReachability.resolvedPath === candidatePersistedSessionFile
        ? 'persisted_file'
        : 'provider_search',
      resolvedPath: providerReachability.resolvedPath,
      effectiveStateMode: input.effectiveStateMode,
    });
  }

  return toResultFail({
    reason: providerReachability.reason || REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
    continuityDiagnostics: {
      materializationIdentityId: input.materializationIdentity.id,
      targetMaterializedRoot: input.targetMaterializedRoot,
      vendorResumeId: asNonEmptyString(input.vendorResumeId),
      cwd: asNonEmptyString(input.cwd),
      candidatePersistedSessionFile,
      requestedStateMode: manifest.requestedStateMode,
      effectiveStateMode: manifest.effectiveStateMode,
      reachabilityMissReason: providerReachability.reason || REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
    },
    diagnostics,
  });
}

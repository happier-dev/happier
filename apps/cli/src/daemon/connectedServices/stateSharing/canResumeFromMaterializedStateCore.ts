import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { ConnectedServiceResumeContinuityDiagnostics } from '@/agent/catalog/types';
import {
  REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
  type VerifyResumeReachableInput,
  type VerifyResumeReachableResult,
} from '@/daemon/connectedServices/verifyResumeReachableTypes';

import {
  readConnectedServiceStateSharingManifest,
  type ConnectedServiceStateSharingManifestV1,
} from './connectedServiceStateSharingManifest';

type StateMode = 'shared' | 'isolated';
type ReachabilitySource = 'persisted_file' | 'manifest_cache_validated' | 'provider_search';

export type CanResumeFromMaterializedStateCoreInput = Readonly<{
  targetMaterializedRoot: string;
  effectiveStateMode: StateMode;
  requestedStateMode: StateMode;
  materializationIdentity: Readonly<{ v: 1; id: string }>;
  vendorResumeId: string;
  cwd: string;
  runtimeDescriptorV1?: VerifyResumeReachableInput['runtimeDescriptorV1'];
  candidatePersistedSessionFile?: string | null;
  manifest?: ConnectedServiceStateSharingManifestV1 | null;
  verifyResumeReachable: (input: VerifyResumeReachableInput) => Promise<VerifyResumeReachableResult>;
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

export async function canResumeFromMaterializedStateCore(
  input: CanResumeFromMaterializedStateCoreInput,
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

  // The candidate is host-custodied current resume evidence. Keep path access
  // here; Agent callbacks receive only their opaque runtime descriptor.
  if (
    candidatePersistedSessionFile
    && isAbsolute(candidatePersistedSessionFile)
    && await statFile(candidatePersistedSessionFile)
  ) {
    return toResultOk({
      source: 'persisted_file',
      resolvedPath: candidatePersistedSessionFile,
      effectiveStateMode: input.effectiveStateMode,
    });
  }

  const providerReachability = await input.verifyResumeReachable({
    targetMaterializedRoot: input.targetMaterializedRoot,
    vendorResumeId: input.vendorResumeId,
    ...(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
  });
  if (providerReachability.ok) {
    return toResultOk({
      source: 'provider_search',
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

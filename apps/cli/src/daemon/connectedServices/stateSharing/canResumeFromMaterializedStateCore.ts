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
  nativeInspection?: VerifyResumeReachableInput['nativeInspection'];
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
  const providerReachability = await input.verifyResumeReachable({
    targetMaterializedRoot: input.targetMaterializedRoot,
    vendorResumeId: input.vendorResumeId,
    ...(candidatePersistedSessionFile ? { candidatePersistedSessionFile } : {}),
    ...(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
    ...(input.nativeInspection ? { nativeInspection: input.nativeInspection } : {}),
  });
  if (providerReachability.ok) {
    if (providerReachability.proof === 'native_session') {
      return toResultOk({ source: 'provider_search', resolvedPath: null, effectiveStateMode: input.effectiveStateMode });
    }
    const validatedManifestMapping = manifest.sessionFileMappings.some((mapping) =>
      mapping.vendorResumeId === input.vendorResumeId
      && resolveManifestCandidatePath({ root: input.targetMaterializedRoot, destinationPath: mapping.destinationPath })
        === providerReachability.resolvedPath,
    );
    return toResultOk({
      source: validatedManifestMapping ? 'manifest_cache_validated'
        : candidatePersistedSessionFile && providerReachability.resolvedPath === candidatePersistedSessionFile
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

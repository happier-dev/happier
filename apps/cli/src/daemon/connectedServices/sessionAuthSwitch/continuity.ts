import type { AccountSettings, ConnectedAccountServiceKey, ConnectedServiceBindingsV2, ConnectedServiceMaterializationIdentityV1, RuntimeDescriptorV1 } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { resolveConnectedServiceSwitchContinuity } from '@/daemon/connectedServices/catalogHooks';
import type { CatalogAgentId, ConnectedServiceSwitchEffectiveBinding } from '@/agent/catalog/types';
import type { TrackedSession } from "@/daemon/types";
import { resolveSharedStateRequiredSwitchContinuity } from "@/daemon/connectedServices/sessionAuthSwitch/sharedStateContinuity";
import { resolveUnsupportedSwitchContinuityErrorCode } from "@/daemon/connectedServices/sessionAuthSwitch/resolveUnsupportedSwitchContinuityErrorCode";
import { readConnectedServiceBindingsOrEmpty } from "@/daemon/connectedServices/sessionAuthSwitch/credentialApplicationState";
import { readConnectedServiceMaterializationIdentityFromEnvironment, readConnectedServiceMaterializationIdentityFromSpawnOptions } from "@/daemon/connectedServices/materialization/identity";

export function resolveConnectedServiceMaterializationIdentityFromTrackedSession(
  tracked: TrackedSession | null | undefined,
): ConnectedServiceMaterializationIdentityV1 | null {
  return (
    readConnectedServiceMaterializationIdentityFromSpawnOptions(
      tracked?.spawnOptions ?? null,
    ) ??
    readConnectedServiceMaterializationIdentityFromEnvironment(
      tracked?.spawnOptions?.environmentVariables ?? null,
    )
  );
}

export async function resolveSessionConnectedServiceSwitchContinuity(
  input: Readonly<{
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedAccountServiceKey;
    previousBinding: ConnectedServiceSwitchEffectiveBinding | null;
    nextBinding: ConnectedServiceSwitchEffectiveBinding;
    tracked?: TrackedSession | null;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    fromBindingsRaw: unknown;
    toBindings: ConnectedServiceBindingsV2;
    accountSettings: AccountSettings | null;
    runtimeAuthSelection?: unknown;
    targetMaterializedRoot?: string | null;
    targetMaterializedEnv?: Readonly<Record<string, string>> | null;
    cwd?: string | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    candidatePersistedSessionFile?: string | null;
    failedFirstLaunch?: 'retry_original_transition';
  }>,
): Promise<Awaited<ReturnType<typeof resolveSharedStateRequiredSwitchContinuity>>> {
  const connectedServiceMaterializationIdentityV1 =
    input.connectedServiceMaterializationIdentityV1 ??
    resolveConnectedServiceMaterializationIdentityFromTrackedSession(
      input.tracked ?? null,
    );
  const vendorResumeId = readNonBlankOpaqueIdentifier(
    input.vendorResumeId ?? input.tracked?.vendorResumeId,
  );
  const continuity = await resolveConnectedServiceSwitchContinuity(
    input.agentId,
    {
      sessionId: input.sessionId,
      agentId: input.agentId,
      serviceId: input.serviceId,
      previousBinding: input.previousBinding,
      nextBinding: input.nextBinding,
      fromBindings: readConnectedServiceBindingsOrEmpty(input.fromBindingsRaw),
      toBindings: input.toBindings,
      connectedServiceMaterializationIdentityV1,
      ...(vendorResumeId ? { vendorResumeId } : {}),
      ...(input.targetMaterializedRoot
        ? { targetMaterializedRoot: input.targetMaterializedRoot }
        : {}),
      ...(input.targetMaterializedEnv
        ? { targetMaterializedEnv: input.targetMaterializedEnv }
        : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.candidatePersistedSessionFile
        ? { candidatePersistedSessionFile: input.candidatePersistedSessionFile }
        : {}),
      ...(input.runtimeAuthSelection === undefined
        ? {}
        : { runtimeAuthSelection: input.runtimeAuthSelection }),
    },
  );
  if (continuity.mode === 'hot_apply') {
    return { mode: 'hot_apply' as const };
  }
  if (continuity.mode === 'restart_same_home') {
    return { mode: 'restart_rematerialize' as const };
  }
  if (continuity.mode === 'restart_shared_state_required') {
    return await resolveSharedStateRequiredSwitchContinuity({
      failedFirstLaunch: input.tracked ? undefined : input.failedFirstLaunch,
      agentId: input.agentId,
      accountSettings: input.accountSettings,
      warnings: continuity.reason ? [continuity.reason] : [],
      serviceId: input.serviceId,
      targetMaterializedRoot: input.targetMaterializedRoot ?? null,
      targetMaterializedEnv: input.targetMaterializedEnv ?? null,
      materializationIdentity:
        connectedServiceMaterializationIdentityV1 ?? null,
      vendorResumeId: vendorResumeId || null,
      cwd: input.cwd ?? null,
      runtimeDescriptorV1: input.runtimeDescriptorV1 ?? null,
      candidatePersistedSessionFile:
        input.candidatePersistedSessionFile ?? null,
    });
  }
  return {
    mode: 'unsupported' as const,
    errorCode: resolveUnsupportedSwitchContinuityErrorCode(continuity.reason),
    warnings: continuity.reason ? [continuity.reason] : [],
    ...(continuity.diagnostics ? { diagnostics: continuity.diagnostics } : {}),
  };
}

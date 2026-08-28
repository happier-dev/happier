import { z } from 'zod';

import { ProviderErrorV1Schema } from '@happier-dev/protocol';

import { claimDaemonForegroundAgentRuntime } from '@/daemon/controlClient';
import {
  HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY,
} from '@/daemon/agentRuntime/foregroundAdmissionContract';
import { readPrivateBearerFile } from '@/daemon/privateBearerFile';
import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
} from './agentRuntimeRunnerProtocol';

const ForegroundAdmissionHandoffSchema = z.object({
  v: z.literal(1),
  capability: z.string().min(1).max(4_096),
  descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
}).strict();

const ForegroundEnvironmentClaimResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    environment: z.record(z.string(), z.string()),
    unsetEnvironmentVariableNames: z.array(z.string()),
    sensitiveEnvironmentVariableNames: z.array(
      z.string().min(1).max(256),
    ).max(256),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: ProviderErrorV1Schema,
    profileSecretRecovery: z.object({
      requirementNames: z.array(z.string().min(1).max(256)).max(256),
    }).strict().optional(),
  }).strict(),
]);

export async function claimDaemonForegroundAgentRuntimeEnvironment(
  params: Readonly<{
    env: NodeJS.ProcessEnv;
    provisionalSessionId: string;
    canonicalSessionId: string;
    attemptId: string;
    foregroundPid: number;
    foregroundSatisfiedProfileSecretRequirementNames: readonly string[];
    nativeHomeSourceEnvironmentValue?: string | null;
    signal?: AbortSignal;
  }>,
) {
  const admissionFilePath =
    params.env[
      HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY
    ]?.trim() ?? '';
  if (!admissionFilePath) {
    throw new Error('Foreground Agent runtime admission capability is missing');
  }
  const handoff = ForegroundAdmissionHandoffSchema.parse(
    JSON.parse(await readPrivateBearerFile(admissionFilePath)),
  );
  return ForegroundEnvironmentClaimResultSchema.parse(
    await claimDaemonForegroundAgentRuntime({
      v: 1,
      attemptId: params.attemptId,
      provisionalSessionId: params.provisionalSessionId,
      canonicalSessionId: params.canonicalSessionId,
      foregroundPid: params.foregroundPid,
      pluginId: handoff.descriptor.pluginId,
      agentId: handoff.descriptor.agentId,
      generation: handoff.descriptor.generation,
      capability: handoff.capability,
      foregroundSatisfiedProfileSecretRequirementNames:
        [...params.foregroundSatisfiedProfileSecretRequirementNames],
      ...(params.nativeHomeSourceEnvironmentValue === undefined
        ? {}
        : {
            nativeHomeSourceEnvironmentValue:
              params.nativeHomeSourceEnvironmentValue,
          }),
    }, {
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  );
}

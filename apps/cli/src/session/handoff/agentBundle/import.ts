import type { ImportedSessionHandoffBundle, SessionHandoffAgentBundle } from '../types';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { applySessionStateUpdatesToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  ExternalSessionsSourceSchema,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

type ProviderHandoffLaunchHints = Readonly<{
  resumePlanOptions?: unknown;
}>;

export type SessionHandoffTypedImportFailureCode =
  | 'target_identity_conflict'
  | 'agent_version_unsupported';

export class SessionHandoffTypedImportError extends Error {
  readonly code: SessionHandoffTypedImportFailureCode;

  constructor(input: Readonly<{
    code: SessionHandoffTypedImportFailureCode;
    message?: string;
    cause?: unknown;
  }>) {
    super(input.message ?? input.code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'SessionHandoffTypedImportError';
    this.code = input.code;
  }
}

function readSessionHandoffTypedImportFailureCode(
  error: unknown,
): SessionHandoffTypedImportFailureCode | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as Readonly<{ code?: unknown }>).code;
  return code === 'target_identity_conflict' || code === 'agent_version_unsupported'
    ? code
    : null;
}

export async function importSessionHandoffAgentBundle(params: Readonly<{
  bundle: SessionHandoffAgentBundle;
  targetPath: string;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedSessionHandoffBundle> {
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(params.bundle.agentId)).handoff;
  if (!providerOps) {
    throw new Error(`Unsupported handoff provider: ${params.bundle.agentId}`);
  }
  let imported;
  try {
    imported = await providerOps.importBundle({
      bundle: params.bundle,
      targetDirectory: params.targetPath,
    });
  } catch (error) {
    const code = readSessionHandoffTypedImportFailureCode(error);
    if (code) {
      throw new SessionHandoffTypedImportError({
        code,
        message: error instanceof Error ? error.message : undefined,
        cause: error,
      });
    }
    throw error;
  }
  if (!imported.ok) {
    const typedCode = readSessionHandoffTypedImportFailureCode(imported);
    if (typedCode) {
      throw new SessionHandoffTypedImportError({
        code: typedCode,
        message: imported.message,
      });
    }
    throw new Error(imported.message ?? `Session handoff import failed: ${imported.code}`);
  }
  const source = ExternalSessionsSourceSchema.parse(imported.value.source);
  const metadataPatch = applySessionStateUpdatesToMetadata({}, imported.value.launch.sessionStateUpdates ?? []);
  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadataPatch) ?? undefined;
  const providerLaunch = imported.value.launch as typeof imported.value.launch & ProviderHandoffLaunchHints;
  const resumePlanOptions = asRecord(providerLaunch.resumePlanOptions);

  return {
    remoteSessionId: imported.value.providerSessionId,
    directSource: source,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    resume: {
      ...(resumePlanOptions ? resumePlanOptions : {}),
      directory: imported.value.launch.directory ?? params.targetPath,
      agent: params.bundle.agentId as ImportedSessionHandoffBundle['resume']['agent'],
      resume: imported.value.providerSessionId,
      ...(imported.value.launch.environmentVariables
        ? { environmentVariables: { ...imported.value.launch.environmentVariables } }
        : {}),
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
    },
  };
}

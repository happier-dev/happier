import {
  CodeIntelligenceCommitAnalyzeResponseV1Schema,
  CodeIntelligenceRepositoryRegisterResponseV1Schema,
  CodeIntelligenceSettingsV1Schema,
  CodeIntelligenceSnapshotResponseV1Schema,
  RPC_METHODS,
  type CodeIntelligenceCommitAnalyzeResponseV1,
  type CodeIntelligenceRepositoryRegisterResponseV1,
  type CodeIntelligenceSettingsV1,
  type CodeIntelligenceSnapshotRequestV1,
  type CodeIntelligenceSnapshotResponseV1,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineTarget = Readonly<{ serverId: string; machineId: string }>;

async function call(target: MachineTarget, method: string, payload: unknown): Promise<unknown> {
  return await machineRpcWithServerScope<unknown, unknown>({
    serverId: target.serverId,
    machineId: target.machineId,
    method,
    payload,
  });
}

export async function fetchCodeIntelligenceSnapshot(
  target: MachineTarget,
  request: CodeIntelligenceSnapshotRequestV1,
): Promise<CodeIntelligenceSnapshotResponseV1> {
  return CodeIntelligenceSnapshotResponseV1Schema.parse(await call(target, RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SNAPSHOT_GET, request));
}

export async function registerCodeIntelligenceRepository(
  target: MachineTarget,
  path: string,
): Promise<CodeIntelligenceRepositoryRegisterResponseV1> {
  return CodeIntelligenceRepositoryRegisterResponseV1Schema.parse(
    await call(target, RPC_METHODS.DAEMON_CODE_INTELLIGENCE_REPOSITORY_REGISTER, { path }),
  );
}

export async function requestCodeIntelligenceCommitAnalysis(
  target: MachineTarget,
  commit: Readonly<{ repositoryId: string; sha: string }>,
): Promise<CodeIntelligenceCommitAnalyzeResponseV1> {
  return CodeIntelligenceCommitAnalyzeResponseV1Schema.parse(
    await call(target, RPC_METHODS.DAEMON_CODE_INTELLIGENCE_COMMIT_ANALYZE, commit),
  );
}

export async function fetchCodeIntelligenceSettings(target: MachineTarget): Promise<CodeIntelligenceSettingsV1> {
  return CodeIntelligenceSettingsV1Schema.parse(await call(target, RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_GET, {}));
}

export async function saveCodeIntelligenceSettings(
  target: MachineTarget,
  settings: CodeIntelligenceSettingsV1,
): Promise<CodeIntelligenceSettingsV1> {
  return CodeIntelligenceSettingsV1Schema.parse(await call(target, RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_SET, { settings }));
}

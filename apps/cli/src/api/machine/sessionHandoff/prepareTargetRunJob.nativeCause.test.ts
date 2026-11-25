import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SessionHandoffPrepareTargetResultGetResponseSchema } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { importSessionHandoffAgentBundle } from '@/session/handoff/agentBundle/import';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { runSessionHandoffPrepareTargetJob } from './prepareTargetRunJob';
import { createSessionHandoffPrepareTargetResultGetActionHandler } from './prepareTargetResultGet';
import { logger } from '@/ui/logger';
import { isTerminalHandoffStatus, readPersistedPrepareJob } from './prepareTargetState';

it('retains the native import cause through durable settlement and result-get after a successful import control', async () => {
  const log = vi.spyOn(logger, 'debug');
  const root = await mkdtemp(join(tmpdir(), 'handoff-native-cause-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
  try {
    const targetPath = join(root, 'workspace');
    const bundle = { agentId: 'claude', remoteSessionId: 'native-cause-session', transcriptBase64: Buffer.from('{}\n').toString('base64') };
    await expect(importSessionHandoffAgentBundle({ bundle, targetPath })).resolves.toMatchObject({ remoteSessionId: bundle.remoteSessionId });
    const activeServerDir = join(root, 'server');
    const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
    const handoffId = 'native_cause';
    const jobId = 'prepare_native_cause';
    const agentBundle = await sourceExportStore.writeAgentBundleFile({ handoffId,
      agentBundle: { ...bundle, transcriptBase64: Buffer.from('{"changed":true}\n').toString('base64') } });
    await sourceExportStore.save({ handoffId, exportedAtMs: 1, agentBundle });
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
    const request = { handoffId, sourceMachineId: 'source', targetMachineId: 'target', targetPath,
      negotiatedTransportStrategy: 'server_routed_stream' as const, sourceSessionStorageMode: 'persisted' as const, endpointCandidates: [] };
    await runSessionHandoffPrepareTargetJob({ activeServerDir, runtimeConfig: { activeServerDir }, jobId, handoffId,
      createdAtMs: 1, request, actualTransportStrategy: 'server_routed_stream',
      pendingStatus: { handoffId, jobId, status: 'pending', phase: 'staging_target', recoveryActions: [] },
      prepareJobStore, sourceExportStore, prepareTargetJobLeaseOwnerId: `test:${process.pid}`,
      machineTransferChannel: undefined, directPeerTransfer: undefined,
      importSessionBundle: (bundle, targetPath, sessionStorageMode) => importSessionHandoffAgentBundle({ bundle, targetPath, sessionStorageMode }) });
    const diagnostics = [{ code: 'transcript_content_mismatch', details: { pathKind: 'transcript_file' } }];
    expect(await prepareJobStore.read(jobId)).toMatchObject({ diagnostics });
    const lines = log.mock.calls.filter(([line]) => line === '[session-handoff] Target import failed');
    expect(lines).toEqual([['[session-handoff] Target import failed', { phase: 'session_handoff.target_import', code: 'target_identity_conflict', diagnostics }]]);
    expect(JSON.stringify(lines)).not.toContain(root);
    const handler = createSessionHandoffPrepareTargetResultGetActionHandler({
      prepareJobStore, readPersistedPrepareJob, isTerminalHandoffStatus,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }) });
    const result = await handler({ handoffId });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_identity_conflict',
      failureCause: { phase: 'session_handoff.target_import', errorCode: 'target_identity_conflict', nativeErrorCode: 'transcript_content_mismatch' } });
    expect(SessionHandoffPrepareTargetResultGetResponseSchema.parse(result)).toMatchObject({ failureCause: { nativeErrorCode: 'transcript_content_mismatch' } });
    expect(result).toHaveProperty('details', { diagnostics });
    expect(SessionHandoffPrepareTargetResultGetResponseSchema.parse(result)).toHaveProperty('details', { diagnostics });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain(bundle.remoteSessionId);
  } finally { log.mockRestore(); await runtime.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

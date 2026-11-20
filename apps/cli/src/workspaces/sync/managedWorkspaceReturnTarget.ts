import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
} from '@/machines/transfer/transferPayloadSource';
import { writeTransferPayloadSourceToFile } from '@/machines/transfer/transferPayloadFileSink';
import { runWorkspaceEffectChannel } from '@/workspaces/activation/workspaceEffectProcess';
import { privateSyncEffectError } from '@/workspaces/activation/privateProjectSyncEffect';
import type { ManagedSessionTarget } from '@/machines/managed/acquire';
import type { ManagedWorkspaceReturnApplyEntry, ManagedWorkspaceReturnTarget } from './managedWorkspaceReturn';
import { applyCapturedWorkspaceSyncEntryAtRoot } from './workspaceSyncConflicts';
import { createWorkspaceSyncEntryExport, stageWorkspaceSyncEntryExport } from './workspaceSyncEntryTransfer';
import type { NativeConfinedApplyOutcome } from './workspaceSyncNativeConfinedFileSystem';
import { workspaceTargetUnavailable } from '../source/workspaceSource';

export type ManagedWorkspaceReturnEffect = Readonly<{
  kind: 'native_workspace_return';
  workspaceRoot: string;
  rootPath: string;
  memberHome: string;
}>;

export type ManagedWorkspaceReturnEffectApply = (entry: Omit<ManagedWorkspaceReturnApplyEntry, 'materialPath'> & Readonly<{
  resolvePayloadSource(transferId: string): Promise<Readonly<{
    sizeBytes: number;
    manifestHash: string;
    readChunk(input: Readonly<{ offset: number; length: number }>): Promise<Uint8Array>;
    dispose(): Promise<void>;
  }>>;
}>) => Promise<NativeConfinedApplyOutcome>;

export function createManagedWorkspaceReturnEffectApply(effect: ManagedWorkspaceReturnEffect, signal: AbortSignal,
  onEffectsIssued: () => void): ManagedWorkspaceReturnEffectApply {
  return async ({ resolvePayloadSource, ...entry }) => {
    signal.throwIfAborted();
    const parent = join(effect.memberHome, '.happier', 'workspace-sync');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, 'return-'));
    let preserveRecovery = false;
    try {
      const materialPath = await stageWorkspaceSyncEntryExport({ operationId: entry.operationId,
        expectation: entry.selectedExpectation, stagingDirectory: join(directory, 'material'),
        requestPayload: async ({ transferId, destinationPath }) => {
          signal.throwIfAborted();
          const source = await resolvePayloadSource(transferId);
          try {
            await writeTransferPayloadSourceToFile({ destinationPath, source: {
              kind: 'native', sizeBytes: source.sizeBytes, manifestHash: source.manifestHash,
              readChunk: async chunk => Buffer.from(await source.readChunk(chunk)),
            } });
          } finally {
            await source.dispose();
          }
        } });
      const recoveryDirectory = join(directory, 'recovery');
      await mkdir(recoveryDirectory, { mode: 0o700 });
      signal.throwIfAborted();
      onEffectsIssued();
      const outcome = await applyCapturedWorkspaceSyncEntryAtRoot({ ...entry, rootPath: effect.rootPath,
        materialPath, recoveryDirectory, assertCurrentAuthority: async () => signal.throwIfAborted() });
      preserveRecovery = outcome.status === 'recovery_needed';
      return outcome;
    } catch (error) {
      throw privateSyncEffectError(error);
    } finally {
      if (!preserveRecovery) await rm(directory, { force: true, recursive: true });
    }
  };
}

export async function runManagedWorkspaceReturnTarget(input: Readonly<{
  target: Pick<ManagedSessionTarget, 'home' | 'ensureWorkspaceRuntime' | 'openChannel'>;
  rootPath: string;
  operationId: string;
  signal: AbortSignal;
  apply: Parameters<ManagedWorkspaceReturnTarget>[1];
}>): Promise<void> {
  const { target, signal } = input;
  const { binaryPath } = await target.ensureWorkspaceRuntime();
  const workspaceRoot = dirname(input.rootPath);
  const effect: ManagedWorkspaceReturnEffect = { kind: 'native_workspace_return', workspaceRoot,
    rootPath: input.rootPath, memberHome: target.home };
  const channel = target.openChannel(['sh', '-c', 'cd "$1" && exec "$2" workspace-effect', 'workspace-return',
    workspaceRoot, binaryPath], signal);
  let failure: unknown;
  let applied = false;
  const outcome = await runWorkspaceEffectChannel({ channel, signal, id: input.operationId, effect, services: {
    fail: async (error: unknown) => { failure = error; },
    applyManagedWorkspaceReturn: async (apply: ManagedWorkspaceReturnEffectApply) => {
      try {
        await input.apply(async ({ materialPath, ...entry }) => {
          signal.throwIfAborted();
          const exported = await createWorkspaceSyncEntryExport({ operationId: entry.operationId,
            expectation: entry.selectedExpectation, materialPath });
          try {
            return await apply({ ...entry, resolvePayloadSource: async transferId => {
              const source = transferId === entry.operationId ? exported.payloadSource
                : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: {} });
              return { sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
                readChunk: async chunk => new Uint8Array(await readTransferPayloadChunk({ source, ...chunk })),
                dispose: async () => { await source.dispose?.(); } };
            } });
          } finally {
            await exported.payloadSource.dispose?.();
          }
        });
        applied = true;
      } catch (error) {
        failure = error;
      }
    },
  }, refusal: code => Object.assign(new Error(code), { code }) });
  if (failure !== undefined) throw failure;
  if (outcome.failure !== undefined) throw outcome.failure;
  if (!outcome.settled || !applied) throw workspaceTargetUnavailable();
}

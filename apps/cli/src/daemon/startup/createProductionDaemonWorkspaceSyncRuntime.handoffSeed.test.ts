import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncSeedRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';

import { createWorkspaceSyncTargetContent, openWorkspaceSyncTargetContent } from '@/api/rpc/workspaceSyncTargetContent';
import type { WorkspaceSyncMachineTunnelOpen } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { createProductionDaemonWorkspaceSyncRuntime, type ProductionDaemonWorkspaceSyncFactories } from './createProductionDaemonWorkspaceSyncRuntime';

describe('createProductionDaemonWorkspaceSyncRuntime session.handoff seed transport', () => {
  it('routes an own-Machine session.handoff remote Git seed through callWorkspaceSeedExport instead of un-routed callMachineRpc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'handoff-seed-runtime-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    let capturedDeps: Parameters<ProductionDaemonWorkspaceSyncFactories['createTargetAuthority']>[0] | undefined;
    const callMachineRpc = vi.fn(async () => {
      throw new Error('un-routed callMachineRpc must not be called for signed session.handoff seeds');
    });
    const callWorkspaceSeedExport = vi.fn(async () => ({
      success: true,
      transferId: 'handoff-op',
      sizeBytes: 12,
      manifestHash: 'sha256:abc',
      endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:41234/transfer/handoff-op', expiresAt: Date.now() + 60_000 }],
    }));
    const openMachineCarrierTunnel = vi.fn<WorkspaceSyncMachineTunnelOpen>().mockResolvedValue({
      localPort: 41234, observedPath: 'direct', localCapability: 'test-capability', close: vi.fn(async () => {}),
    });
    const requestDirectTransferPayloadFile = vi.fn(async () => {});
    const materializeSeedExport = vi.fn(async () => ({
      commit: async () => {},
      abort: async () => {},
    }));
    const token = [Buffer.from('{}').toString('base64url'), Buffer.from('{"sub":"guest"}').toString('base64url'), 'sig'].join('.');
    const createRuntime = (withSignedSeed: boolean) => createProductionDaemonWorkspaceSyncRuntime({
      happyHomeDir: dir,
      activeServerDir: join(dir, 'server'),
      activeServerId: 'home',
      localMachineId: 'target-machine',
      releaseChannel: 'publicdev',
      credentials: { token, encryption: null },
      ...(withSignedSeed ? { callWorkspaceSeedExport } : {}),
      openMachineCarrierTunnel,
      requestDirectTransferPayloadFile,
    }, {
      createTargetAuthority: ((deps: Parameters<ProductionDaemonWorkspaceSyncFactories['createTargetAuthority']>[0]) => {
        capturedDeps = deps;
        return {} as never;
      }) as never,
      callMachineRpc: callMachineRpc as never,
      materializeSeedExport: materializeSeedExport as never,
      getProjectSnapshot: () => null,
      subscribeProjectSnapshot: () => () => {},
      resolveRootOwnershipDirectory: () => join(dir, 'locks'),
    });

    const content = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...content, policyDigest: computeWorkspaceSyncPolicyDigest(content) };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'handoff-root',
      binding: {
        accountId: 'guest',
        custodianAccountId: 'owner',
        admittedMachineRole: 'use',
        authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain',
        serverIdentityId: 'home',
        machineId: 'source-machine',
        installationId: 'source-installation',
        actionId: 'session.handoff',
        requestId: 'handoff-op',
        requestEnvelopeDigest: 'A'.repeat(43),
        target: { kind: 'machine', machineId: 'source-machine' },
        handoffAdmission: {
          sessionId: 'guest-session',
          sourceMachineId: 'source-machine',
          sourceInstallationId: 'source-installation',
          targetMachineId: 'target-machine',
          targetInstallationId: 'target-installation',
        },
      },
    });
    const workspaceSyncSourceWriterTargetRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
      v: 1,
      source: {
        v: 1,
        phase: 'prepare',
        operationId: 'handoff-op',
        accountServerId: 'home',
        sourceSessionId: 'guest-session',
        sourceMachineId: 'source-machine',
        sourceRootPath: '/source/repo',
        sourceContext: {
          machineAdmission: {
            actorAccountId: 'guest',
            custodianAccountId: 'owner',
            machineId: 'source-machine',
            installationId: 'source-installation',
            role: 'use',
            encryptionMode: 'plain',
          },
          callerAuthority: 'present_user',
        },
      },
      sourceWriter: { machineId: 'source-machine', installationId: 'source-installation' },
      target: {
        v: 1,
        phase: 'prepare',
        operationId: 'handoff-op',
        accountServerId: 'home',
        targetMachineId: 'target-machine',
        targetRootPath: '/guest/repo',
      },
    });
    const context = {
      signal: new AbortController().signal,
      callerAuthority: 'present_user' as const,
      machineAdmission: {
        actorAccountId: 'guest',
        custodianAccountId: 'guest',
        machineId: 'target-machine',
        installationId: 'target-installation',
        role: 'manage' as const,
        encryptionMode: 'plain' as const,
      },
      callerInputAuthorization: authorization,
      workspaceSyncSourceWriterTargetRouting,
    };
    const seedRequest = {
      operationId: 'handoff-op',
      sourceMachineId: 'source-machine',
      sourceWorkspaceRefId: 'source-ref',
      canonicalRoot: '/guest/repo',
      contentPolicy,
      materializationReceiptPath: join(dir, 'receipt.json'),
      originalTargetExists: false,
      targetFence: { kind: 'empty' as const },
      context,
    };

    createRuntime(true);
    expect(capturedDeps).toBeDefined();
    await capturedDeps!.bootstrap!.materializeRemoteSeed!(seedRequest);
    expect(callWorkspaceSeedExport).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).not.toHaveBeenCalled();

    // Without callWorkspaceSeedExport, signed session.handoff must fail closed rather than calling un-routed callMachineRpc.
    createRuntime(false);
    await expect(capturedDeps!.bootstrap!.materializeRemoteSeed!(seedRequest)).rejects.toMatchObject({
      code: 'workspace_sync_update_required',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('opens sealed workspace sync seed content on SOURCE after Home strips carrierPublicKey from workspaceSyncSeedRouting', async () => {
    const sourceKeyPair = tweetnacl.sign.keyPair();
    const seedRouting = WorkspaceSyncSeedRoutingV1Schema.parse({
      v: 1,
      sourceWriterTarget: {
        v: 1,
        source: {
          v: 1,
          phase: 'prepare',
          operationId: 'handoff-op',
          accountServerId: 'home',
          sourceSessionId: 'guest-session',
          sourceMachineId: 'source-machine',
          sourceRootPath: '/source/repo',
          sourceContext: {
            machineAdmission: {
              actorAccountId: 'guest',
              custodianAccountId: 'owner',
              machineId: 'source-machine',
              installationId: 'source-installation',
              role: 'use',
              encryptionMode: 'plain',
            },
            callerAuthority: 'present_user',
          },
        },
        sourceWriter: { machineId: 'source-machine', installationId: 'source-installation' },
        target: {
          v: 1,
          phase: 'prepare',
          operationId: 'handoff-op',
          accountServerId: 'home',
          targetMachineId: 'target-machine',
          targetRootPath: '/guest/repo',
        },
      },
      target: {
        v: 1,
        phase: 'prepare',
        operationId: 'handoff-op',
        accountServerId: 'home',
        targetMachineId: 'target-machine',
        targetRootPath: '/guest/repo',
        targetContext: {
          machineAdmission: {
            actorAccountId: 'guest',
            custodianAccountId: 'guest',
            machineId: 'target-machine',
            installationId: 'target-installation',
            role: 'manage',
            encryptionMode: 'plain',
          },
          callerAuthority: 'present_user',
        },
      },
    });
    const destination = {
      machineId: 'source-machine',
      installationId: 'source-installation',
      installationPublicKey: Buffer.from(sourceKeyPair.publicKey).toString('base64url'),
    };
    const method = `source-machine:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`;
    const payload = { t: 'workspace_sync_seed_v1', operationId: 'handoff-op' };
    const sourceInstallation = {
      version: 1 as const,
      installationId: 'source-installation',
      createdAt: 1,
      publicKey: Buffer.from(sourceKeyPair.publicKey).toString('base64url'),
      privateKey: Buffer.from(sourceKeyPair.secretKey).toString('base64url'),
    };
    // Home forwards seedRouting without carrierPublicKey (registerSocketRpcHandlers.ts:2425-2428).
    const content = createWorkspaceSyncTargetContent({ destination, method, routing: seedRouting });
    if (content.mode !== 'e2ee') throw new Error('Expected installed-key encryption');
    const validCiphertext = await content.cipher.encryptRaw(payload);
    const opened = openWorkspaceSyncTargetContent({
      ciphertext: validCiphertext,
      installation: sourceInstallation,
      machineId: 'source-machine',
      method,
      routing: seedRouting,
    });
    expect(opened).not.toBeNull();
    if (opened?.mode !== 'e2ee') throw new Error('Expected opened installed-key encryption');
    expect(await opened.cipher.decryptRaw(validCiphertext)).toEqual(payload);
    // Sealing carrierPublicKey into content breaks SOURCE opening once Home strips carrierPublicKey (B23 F4).
    const wireSeedRoutingWithCarrier = { ...seedRouting, carrierPublicKey: Buffer.from(tweetnacl.sign.keyPair().publicKey).toString('base64url') };
    const brokenContent = createWorkspaceSyncTargetContent({ destination, method, routing: wireSeedRoutingWithCarrier });
    if (brokenContent.mode !== 'e2ee') throw new Error('Expected installed-key encryption');
    const brokenCiphertext = await brokenContent.cipher.encryptRaw(payload);
    expect(openWorkspaceSyncTargetContent({
      ciphertext: brokenCiphertext,
      installation: sourceInstallation,
      machineId: 'source-machine',
      method,
      routing: seedRouting,
    })).toBeNull();
  });
});

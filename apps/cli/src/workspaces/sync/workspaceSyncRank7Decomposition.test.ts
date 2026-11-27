import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import {
  computeWorkspaceSyncPolicyDigest,
  type ExternalActionExecutionAuthorizationV1,
  type WorkspaceRefV1,
  type WorkspaceSyncRelationshipV1,
} from '@happier-dev/protocol';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionRequesterAccountProjectionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { TransferEndpointCandidate } from '@happier-dev/protocol/machines/transfer/transferStream';
import type { ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readReviewedExternalActionInput } from '@/api/externalActionExecutionAuthorization';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { PrivateProjectNativeSync } from '@/workspaces/activation/privateProjectSyncEffect';
import { createWorkspaceSyncExecutionRegistry } from './workspaceSyncExecutionRegistry';
import {
  buildLoopbackDirectTransferCandidate,
  createTempDirPayloadSourceResolver,
  fetchDirectTransferPayloadViaCarrier,
  isValidDirectTransferSizeBytes,
  openDirectTransferPayloadEndpoint,
  parsePreparedDirectTransferExport,
} from './directTransferSeedClient';
import {
  selectWorkspaceSyncTargetDriver,
  type TargetDriverSharedDeps,
} from './workspaceSyncTargetDriver';
import type {
  PrepareWorkspaceSyncHandoffInput,
  RetainedWorkspaceSyncPrivateExecution,
  WorkspaceSyncPrivateExecution,
} from './workspaceSyncHandoffAdapter';
import { createWorkspaceSyncTargetAuthority, type WorkspaceSyncNativeTargetExecution, type WorkspaceSyncTargetAuthority } from './workspaceSyncTargetAuthority';

const SERVER_ID = 'srv_home_1';
const LOCAL_MACHINE_ID = 'machine-local';
const REMOTE_MACHINE_ID = 'machine-remote';
const ZERO_FILE_DIGEST = '0'.repeat(40);
const MANAGED_FILE_DIGEST = 'a'.repeat(40);
const ROOT_FINGERPRINT = 'f'.repeat(64);

function makeHostWorkspaceRef(overrides: Partial<Extract<WorkspaceRefV1, { kind?: 'host' }>> = {}): WorkspaceRefV1 {
  return {
    v: 1,
    id: 'ws-alpha',
    serverId: SERVER_ID,
    machineId: LOCAL_MACHINE_ID,
    rootPath: '/work/alpha',
    ...overrides,
  } as WorkspaceRefV1;
}

function makeManagedWorkspaceRef(overrides: Partial<ManagedWorkspaceRefV2> = {}): ManagedWorkspaceRefV2 {
  return {
    v: 2,
    kind: 'managed',
    id: 'ws-managed',
    serverId: SERVER_ID,
    managedId: 'box-1',
    controller: { machineId: LOCAL_MACHINE_ID, installationId: 'inst-1' },
    rootPath: '/workspace/managed',
    ...overrides,
  };
}

function makeRelationship(overrides: Partial<WorkspaceSyncRelationshipV1> = {}): WorkspaceSyncRelationshipV1 {
  return {
    v: 1,
    relationshipId: 'rel-1',
    mode: 'mirror',
    controllerMachineId: LOCAL_MACHINE_ID,
    alphaWorkspaceRefId: 'ws-alpha',
    betaWorkspaceRefId: 'ws-beta',
    syncEngine: 'mutagen',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as WorkspaceSyncRelationshipV1;
}

function makeHandoffInput(overrides: Partial<PrepareWorkspaceSyncHandoffInput> = {}): PrepareWorkspaceSyncHandoffInput {
  return {
    operationId: 'op-1',
    accountServerId: SERVER_ID,
    sourceMachineId: LOCAL_MACHINE_ID,
    targetMachineId: REMOTE_MACHINE_ID,
    sourceWorkspaceRefId: 'ws-alpha',
    targetWorkspaceRefId: 'ws-beta',
    sourceRootPath: '/work/alpha',
    targetRootPath: '/work/beta',
    action: { kind: 'copy_once' },
    ...overrides,
  } as PrepareWorkspaceSyncHandoffInput;
}

function makePrivateExecution(overrides: Partial<WorkspaceSyncPrivateExecution> = {}): WorkspaceSyncPrivateExecution {
  return {
    credentials: { token: 'tok', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
    accountRowsCustody: {
      accountId: 'acct-1',
      serverId: SERVER_ID,
      serverHttpBaseUrl: 'https://home.example.test',
    },
    assertTransferCurrent: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WorkspaceSyncPrivateExecution;
}

function makeTargetDriverDeps(overrides: Partial<TargetDriverSharedDeps> = {}): TargetDriverSharedDeps {
  const targetAuthority = {
    prepareBootstrapAtTarget: vi.fn(async () => ({
      v: 1,
      bootstrapOperationId: 'boot-1',
      targetWorkspaceRefId: 'ws-beta',
      targetRootPath: '/work/beta',
      rootFingerprint: ROOT_FINGERPRINT,
      physicalEndpoint: { machineId: REMOTE_MACHINE_ID, installationId: 'inst-remote', publicKey: 'pk-remote' },
      ownershipHandles: [],
    })),
    releaseBootstrapAtTarget: vi.fn(async () => {}),
    releaseBootstrapHere: vi.fn(async () => {}),
    previewCommittedCopyAtTarget: vi.fn(async () => ({
      ok: true as const,
      preview: {
        targetMachineId: REMOTE_MACHINE_ID,
        workspaceRefId: 'ws-beta',
        rootFingerprint: ROOT_FINGERPRINT,
      },
    })),
    stageConflictResolutionHere: vi.fn(async () => {}),
    stageConflictResolutionAtTarget: vi.fn(async () => {}),
    applyStagedConflictResolutionHere: vi.fn(async () => ({ status: 'installed' as const })),
    applyStagedConflictResolutionAtTarget: vi.fn(async () => ({ status: 'installed' as const })),
    discardStagedConflictResolutionHere: vi.fn(async () => {}),
    discardStagedConflictResolutionAtTarget: vi.fn(async () => {}),
    releaseConflictResolutionCaptureHere: vi.fn(async () => {}),
    releaseConflictResolutionCaptureAtSource: vi.fn(async () => {}),
    recoverConflictResolutionHere: vi.fn(async () => ({ status: 'settled' as const })),
    recoverConflictResolutionAtTarget: vi.fn(async () => ({ status: 'settled' as const })),
    readFileHere: vi.fn(async () => ({ status: 'text' as const, text: '', digest: ZERO_FILE_DIGEST, size: 0 })),
    readFileAtTarget: vi.fn(async () => ({ status: 'text' as const, text: '', digest: ZERO_FILE_DIGEST, size: 0 })),
    observeEntryHere: vi.fn(async () => ({ kind: 'missing' as const })),
    observeEntryAtTarget: vi.fn(async () => ({ kind: 'missing' as const })),
    getPreparedBootstrapOwnership: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  } as unknown as WorkspaceSyncTargetAuthority;

  return {
    localMachineId: LOCAL_MACHINE_ID,
    serverId: SERVER_ID,
    targetAuthority,
    registry: createWorkspaceSyncExecutionRegistry(),
    resolveLocalResolutionEndpoint: vi.fn(async () => null),
    openManagedNative: vi.fn(async () => null),
    compositionError: (code, message) => Object.assign(new Error(message), { code }),
    ...overrides,
  };
}

describe('Rank 7 Phase 1 — WorkspaceSyncExecutionRegistry', () => {
  it('indexes retained executions across operationId, relationshipId, rootPath, and managedTarget and clears all indices on release', async () => {
    const registry = createWorkspaceSyncExecutionRegistry();
    const managedWorkspace = makeManagedWorkspaceRef({ rootPath: '/workspace/managed/' });
    const retainRelationship = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    const execution = makePrivateExecution({
      retainRelationship,
      release,
      managedTarget: { workspace: managedWorkspace } as WorkspaceSyncPrivateExecution['managedTarget'],
      getSnapshot: () => ({
        workspaceRefs: [makeHostWorkspaceRef({ id: 'ws-alpha' }), managedWorkspace],
        relationships: [],
      }) as ReturnType<NonNullable<WorkspaceSyncPrivateExecution['getSnapshot']>>,
    });
    const input = makeHandoffInput({
      operationId: 'op-managed',
      sourceRootPath: '/work/src',
      targetRootPath: '/work/dst',
    });

    registry.retain({ input, execution });
    expect(registry.hasOperation('op-managed')).toBe(true);
    expect(registry.getByOperationId('op-managed')?.phase).toBe('open');
    expect(registry.findByRootPath('/work/src')).toHaveLength(1);
    expect(registry.findByRootPath('/work/dst')).toHaveLength(1);
    expect(registry.findByRootPath('/workspace/managed/')).toHaveLength(1);
    expect(registry.findByManagedTarget({
      serverId: SERVER_ID,
      managedId: 'box-1',
      controller: managedWorkspace.controller,
      rootPath: '/workspace/managed',
    }, { accountId: 'acct-1', serverId: SERVER_ID })?.input.operationId).toBe('op-managed');
    expect(registry.findByManagedTarget(managedWorkspace, { accountId: 'other-acct' })).toBeNull();

    await registry.bindRelationship('op-managed', 'rel-managed', 'relationship');
    expect(retainRelationship).toHaveBeenCalledWith('rel-managed');
    expect(registry.findByRelationshipId('rel-managed')?.phase).toBe('relationship');
    expect(registry.findByOperationOrRelationship('rel-managed')?.input.operationId).toBe('op-managed');
    expect(registry.findForRequester('rel-managed', 'acct-1', SERVER_ID)?.input.operationId).toBe('op-managed');
    expect(registry.findForRequester('rel-managed', 'acct-2', SERVER_ID)).toBeNull();
    expect(registry.findForRequester('rel-managed', 'acct-1', 'other-server')).toBeNull();
    expect(registry.findManagedByEndpoint('rel-managed', 'ws-managed')?.input.operationId).toBe('op-managed');
    expect(registry.findManagedByEndpoint('rel-managed', 'ws-wrong')).toBeNull();
    expect(registry.resolve({ operationId: 'op-managed', relationshipId: 'rel-managed' })?.input.operationId).toBe('op-managed');
    expect(registry.resolve({ operationId: 'op-managed', relationshipId: 'rel-mismatch' })).toBeNull();
    expect(registry.resolveWorkspaceRef('ws-alpha', SERVER_ID)).toEqual({
      kind: 'resolved',
      workspace: makeHostWorkspaceRef({ id: 'ws-alpha' }),
    });
    expect(registry.resolveWorkspaceRef('ws-missing', SERVER_ID)).toEqual({ kind: 'unowned' });
    expect(registry.resolveWorkspaceRef('ws-alpha', 'wrong-server')).toEqual({ kind: 'unavailable' });

    await registry.release('op-managed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(registry.hasOperation('op-managed')).toBe(false);
    expect(registry.findByRelationshipId('rel-managed')).toBeNull();
    expect(registry.findByRootPath('/work/src')).toEqual([]);
    expect(registry.findByManagedTarget(managedWorkspace)).toBeNull();
  });

  it('preserves earlier retained execution across all lookups when a second operation binds and releases the same relationshipId', async () => {
    const registry = createWorkspaceSyncExecutionRegistry();
    const managedTarget = makeManagedWorkspaceRef({ id: 'ws-shared-managed', rootPath: '/workspace/shared-rel' });
    const sharedCustody = { accountId: 'acct-shared', serverId: SERVER_ID, serverHttpBaseUrl: 'https://home.example.test', isCurrent: async () => true };
    const execA = makePrivateExecution({
      accountRowsCustody: sharedCustody,
      managedTarget: {
        workspace: managedTarget,
        open: vi.fn(async () => ({ native: {} as PrivateProjectNativeSync })),
        close: vi.fn(async () => undefined),
      } as WorkspaceSyncPrivateExecution['managedTarget'],
    });
    const execB = makePrivateExecution({ accountRowsCustody: sharedCustody });

    registry.retain({
      input: makeHandoffInput({ operationId: 'op-rel-1', sourceRootPath: '/work/src-1', targetRootPath: '/workspace/shared-rel' }),
      execution: execA,
      relationshipId: 'rel-shared-1',
      phase: 'relationship',
    });
    registry.retain({
      input: makeHandoffInput({ operationId: 'op-open-2', sourceRootPath: '/work/src-2', targetRootPath: '/workspace/shared-rel' }),
      execution: execB,
      phase: 'open',
    });
    await registry.bindRelationship('op-open-2', 'rel-shared-1');

    // First-inserted operation wins while both are bound (matching pre-patch scan order)
    expect(registry.findByRelationshipId('rel-shared-1')?.input.operationId).toBe('op-rel-1');
    expect(registry.findByOperationOrRelationship('rel-shared-1')?.input.operationId).toBe('op-rel-1');
    expect(registry.findForRequester('rel-shared-1', 'acct-shared', SERVER_ID)?.input.operationId).toBe('op-rel-1');
    expect(registry.findManagedByEndpoint('rel-shared-1', 'ws-shared-managed')?.input.operationId).toBe('op-rel-1');
    expect(registry.resolve({ relationshipId: 'rel-shared-1' })?.input.operationId).toBe('op-rel-1');

    // Releasing the second operation must never orphan the live first operation
    await registry.release('op-open-2');
    expect(registry.getByOperationId('op-open-2')).toBeNull();
    expect(registry.findByRelationshipId('rel-shared-1')?.input.operationId).toBe('op-rel-1');
    expect(registry.findByOperationOrRelationship('rel-shared-1')?.input.operationId).toBe('op-rel-1');
    expect(registry.findForRequester('rel-shared-1', 'acct-shared', SERVER_ID)?.input.operationId).toBe('op-rel-1');
    expect(registry.findManagedByEndpoint('rel-shared-1', 'ws-shared-managed')?.input.operationId).toBe('op-rel-1');
    expect(registry.resolve({ relationshipId: 'rel-shared-1' })?.input.operationId).toBe('op-rel-1');

    // Releasing the remaining operation cleans up the bucket completely
    await registry.release('op-rel-1');
    expect(registry.findByRelationshipId('rel-shared-1')).toBeNull();
    expect(registry.findByOperationOrRelationship('rel-shared-1')).toBeNull();
    expect(registry.findForRequester('rel-shared-1', 'acct-shared', SERVER_ID)).toBeNull();
    expect(registry.findManagedByEndpoint('rel-shared-1', 'ws-shared-managed')).toBeNull();
    expect(registry.resolve({ relationshipId: 'rel-shared-1' })).toBeNull();
  });

  it('refuses conflicting operationId reuse and conflicting relationshipId rebinding with workspace_sync_operation_conflict', async () => {
    const registry = createWorkspaceSyncExecutionRegistry();
    const input = makeHandoffInput({ operationId: 'op-conflict' });
    const execution = makePrivateExecution();

    registry.retain({ input, execution });
    expect(() => registry.retain({ input, execution, phase: 'relationship' })).not.toThrow();
    expect(() => registry.retain({ input, execution: makePrivateExecution() }))
      .toThrow(expect.objectContaining({ code: 'workspace_sync_operation_conflict' }));

    await registry.bindRelationship('op-conflict', 'rel-a');
    await expect(registry.bindRelationship('op-conflict', 'rel-b'))
      .rejects.toMatchObject({ code: 'workspace_sync_operation_conflict' });
  });

  it('releaseAll attempts every execution and throws AggregateError when one fails', async () => {
    const registry = createWorkspaceSyncExecutionRegistry();
    const releaseOk = vi.fn(async () => {});
    const releaseBoom = vi.fn(async () => { throw new Error('release boom'); });
    registry.retain({ input: makeHandoffInput({ operationId: 'op-ok' }), execution: makePrivateExecution({ release: releaseOk }) });
    registry.retain({ input: makeHandoffInput({ operationId: 'op-boom' }), execution: makePrivateExecution({ release: releaseBoom }) });

    await expect(registry.releaseAll()).rejects.toBeInstanceOf(AggregateError);
    expect(releaseOk).toHaveBeenCalledTimes(1);
    expect(releaseBoom).toHaveBeenCalledTimes(1);
    expect(registry.hasOperation('op-ok')).toBe(false);
    expect(registry.hasOperation('op-boom')).toBe(true);
  });
});

describe('Rank 7 Phase 1 — directTransferSeedClient', () => {
  const sourceCandidate: TransferEndpointCandidate = {
    kind: 'http',
    url: 'http://192.0.2.10:4444/old-path',
    authorizationToken: 'token-1',
    expiresAt: Date.now() + 60_000,
  };

  it('enforces canonical sizeBytes >= 0 invariant (including zero-byte payloads) and rejects negative or non-integer values', () => {
    expect(isValidDirectTransferSizeBytes(0)).toBe(true);
    expect(isValidDirectTransferSizeBytes(1)).toBe(true);
    expect(isValidDirectTransferSizeBytes(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidDirectTransferSizeBytes(-1)).toBe(false);
    expect(isValidDirectTransferSizeBytes(1.5)).toBe(false);
    expect(isValidDirectTransferSizeBytes(Number.NaN)).toBe(false);
    expect(isValidDirectTransferSizeBytes(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidDirectTransferSizeBytes(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isValidDirectTransferSizeBytes('0')).toBe(false);

    const parsedZero = parsePreparedDirectTransferExport({
      raw: {
        success: true,
        transferId: 'xfer-zero',
        sizeBytes: 0,
        manifestHash: 'sha256:e3b0c442',
        endpointCandidates: [sourceCandidate],
      },
      expectedTransferId: 'xfer-zero',
      createInvalidError: msg => Object.assign(new Error(msg), { code: 'invalid_export' }),
    });
    expect(parsedZero.sizeBytes).toBe(0);
    expect(parsedZero.transferId).toBe('xfer-zero');

    expect(() => parsePreparedDirectTransferExport({
      raw: {
        success: true,
        transferId: 'xfer-neg',
        sizeBytes: -1,
        manifestHash: 'sha256:bad',
        endpointCandidates: [sourceCandidate],
      },
      expectedTransferId: 'xfer-neg',
      createInvalidError: msg => Object.assign(new Error(msg), { code: 'invalid_export' }),
    })).toThrow(expect.objectContaining({ code: 'invalid_export' }));
  });

  it('rewrites endpoint candidates onto loopback HTTP and handles same-machine, carrier-opened, and caller-issued tunnels cleanly', async () => {
    const rewritten = buildLoopbackDirectTransferCandidate({
      sourceCandidate,
      transferId: 'xfer-1',
      localPort: 51234,
    });
    expect(new URL(rewritten.url).hostname).toBe('127.0.0.1');
    expect(new URL(rewritten.url).port).toBe('51234');
    expect(new URL(rewritten.url).protocol).toBe('http:');

    const openCarrier = vi.fn();
    const sameMachine = await openDirectTransferPayloadEndpoint({
      sourceCandidate,
      transferId: 'xfer-same',
      localMachineId: LOCAL_MACHINE_ID,
      sourceMachineId: LOCAL_MACHINE_ID,
      openCarrier,
    });
    expect(openCarrier).not.toHaveBeenCalled();
    expect(new URL(sameMachine.endpointCandidates[0]!.url).port).toBe('4444');
    await sameMachine.dispose();

    const issuedClose = vi.fn(async () => {});
    const withIssued = await openDirectTransferPayloadEndpoint({
      sourceCandidate,
      transferId: 'xfer-issued',
      localMachineId: LOCAL_MACHINE_ID,
      sourceMachineId: REMOTE_MACHINE_ID,
      issuedTunnel: { localPort: 60001, close: issuedClose },
      openCarrier,
    });
    expect(openCarrier).not.toHaveBeenCalled();
    expect(new URL(withIssued.endpointCandidates[0]!.url).port).toBe('60001');
    await withIssued.dispose();
    expect(issuedClose).not.toHaveBeenCalled();
  });

  it('forwards expectedSizeBytes: 0 on root payloads, enforces requireCommitment, and always closes opened tunnel on fetch failure', async () => {
    const prepared = parsePreparedDirectTransferExport({
      raw: {
        success: true,
        transferId: 'xfer-root',
        sizeBytes: 0,
        manifestHash: 'sha256:empty',
        endpointCandidates: [sourceCandidate],
      },
      expectedTransferId: 'xfer-root',
      createInvalidError: msg => new Error(msg),
    });

    const tunnelClose = vi.fn(async () => {});
    const openCarrier = vi.fn(async () => ({ localPort: 61234, close: tunnelClose }));
    const fetchPayloadFile = vi.fn(async () => {});

    await fetchDirectTransferPayloadViaCarrier({
      prepared,
      transferId: 'xfer-root',
      destinationPath: '/tmp/unused',
      requireCommitment: true,
      localMachineId: LOCAL_MACHINE_ID,
      sourceMachineId: REMOTE_MACHINE_ID,
      openCarrier,
      fetchPayloadFile,
    });
    expect(fetchPayloadFile).toHaveBeenCalledWith(expect.objectContaining({
      transferId: 'xfer-root',
      expectedSizeBytes: 0,
      expectedManifestHash: 'sha256:empty',
    }));
    expect(tunnelClose).toHaveBeenCalledTimes(1);

    openCarrier.mockClear();
    await expect(fetchDirectTransferPayloadViaCarrier({
      prepared,
      transferId: 'xfer-child',
      destinationPath: '/tmp/unused',
      requireCommitment: true,
      createInvalidCommitmentError: msg => Object.assign(new Error(msg), { code: 'commitment_missing' }),
      localMachineId: LOCAL_MACHINE_ID,
      sourceMachineId: REMOTE_MACHINE_ID,
      openCarrier,
      fetchPayloadFile,
    })).rejects.toMatchObject({ code: 'commitment_missing' });
    expect(openCarrier).not.toHaveBeenCalled();

    const failingTunnelClose = vi.fn(async () => {});
    await expect(fetchDirectTransferPayloadViaCarrier({
      prepared,
      transferId: 'xfer-root',
      destinationPath: '/tmp/unused',
      localMachineId: LOCAL_MACHINE_ID,
      sourceMachineId: REMOTE_MACHINE_ID,
      openCarrier: async () => ({ localPort: 61235, close: failingTunnelClose }),
      fetchPayloadFile: async () => { throw new Error('network drop'); },
    })).rejects.toThrow('network drop');
    expect(failingTunnelClose).toHaveBeenCalledTimes(1);
  });

  it('createTempDirPayloadSourceResolver serves file chunks and removes its temp directory even when releaseUnderlying rejects', async () => {
    let createdFilePath = '';
    const releaseUnderlying = vi.fn(async () => { throw new Error('release fail'); });
    const resolver = await createTempDirPayloadSourceResolver({
      prefix: 'rws-rank7-test-',
      fetchToFile: async ({ destinationPath }) => {
        createdFilePath = destinationPath;
        await writeFile(destinationPath, Buffer.from('hello-sync'));
      },
      releaseUnderlying,
    });

    const source = await resolver.resolvePayloadSource({ transferId: 'xfer-chunk' });
    expect(source.sizeBytes).toBe(10);
    expect(source.manifestHash).toMatch(/^sha256:/);
    const chunk = await source.readChunk({ offset: 6, length: 4 });
    expect(chunk.toString('utf8')).toBe('sync');

    await expect(resolver.dispose()).rejects.toThrow('release fail');
    expect(releaseUnderlying).toHaveBeenCalledTimes(1);
    await expect(access(dirname(createdFilePath))).rejects.toThrow();
  });
});

describe('Rank 7 Phase 1 — WorkspaceSyncTargetDriver selection & observeCommittedTarget parity', () => {
  it('selects all 4 canonical driver topologies accurately', () => {
    const deps = makeTargetDriverDeps();
    expect(selectWorkspaceSyncTargetDriver(deps, null).kind).toBe('installed_host');

    const managedRetained: RetainedWorkspaceSyncPrivateExecution = {
      input: makeHandoffInput({ targetMachineId: LOCAL_MACHINE_ID }),
      phase: 'relationship',
      execution: makePrivateExecution({
        managedTarget: { workspace: makeManagedWorkspaceRef() } as WorkspaceSyncPrivateExecution['managedTarget'],
      }),
    };
    expect(selectWorkspaceSyncTargetDriver(deps, managedRetained).kind).toBe('managed_container');

    const isolatedRetained: RetainedWorkspaceSyncPrivateExecution = {
      input: makeHandoffInput({ targetMachineId: LOCAL_MACHINE_ID }),
      phase: 'relationship',
      execution: makePrivateExecution({
        nativeSync: {} as PrivateProjectNativeSync,
      }),
    };
    expect(selectWorkspaceSyncTargetDriver(deps, isolatedRetained).kind).toBe('isolated_member');

    const remoteRetained: RetainedWorkspaceSyncPrivateExecution = {
      input: makeHandoffInput({ targetMachineId: REMOTE_MACHINE_ID }),
      phase: 'relationship',
      execution: makePrivateExecution({
        callTargetPhase: vi.fn(async () => ({ ok: false, errorCode: 'workspace_copy_not_owned' })),
      }),
    };
    expect(selectWorkspaceSyncTargetDriver(deps, remoteRetained).kind).toBe('signed_remote_requester');
  });

  it('preserves observeCommittedTarget parity across installed_host, signed_remote_requester, and managed_container', async () => {
    const deps = makeTargetDriverDeps();
    const relationship = makeRelationship();
    const remoteTarget = makeHostWorkspaceRef({ id: 'ws-beta', machineId: REMOTE_MACHINE_ID, rootPath: '/work/beta' });

    const installedDriver = selectWorkspaceSyncTargetDriver(deps, null);
    expect(await installedDriver.observeCommittedTarget({ relationship, target: remoteTarget })).toBe('present');
    expect(deps.targetAuthority.previewCommittedCopyAtTarget).toHaveBeenCalledTimes(1);

    const callTargetPhase = vi.fn(async () => ({ ok: false as const, errorCode: 'workspace_copy_not_owned' as const }));
    const remoteRetained: RetainedWorkspaceSyncPrivateExecution = {
      input: makeHandoffInput({ operationId: 'op-remote', targetMachineId: REMOTE_MACHINE_ID }),
      phase: 'relationship',
      execution: makePrivateExecution({ callTargetPhase }),
    };
    const remoteDriver = selectWorkspaceSyncTargetDriver(deps, remoteRetained);
    expect(await remoteDriver.observeCommittedTarget({ relationship, target: remoteTarget })).toBe('absent');
    expect(callTargetPhase).toHaveBeenCalledWith(expect.objectContaining({
      machineId: REMOTE_MACHINE_ID,
      method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT,
      routing: expect.objectContaining({ phase: 'inspect', operationId: 'op-remote', targetRootPath: '/work/beta' }),
    }));

    const missingTransportRetained: RetainedWorkspaceSyncPrivateExecution = {
      input: makeHandoffInput({ operationId: 'op-missing', targetMachineId: REMOTE_MACHINE_ID }),
      phase: 'relationship',
      execution: makePrivateExecution({}),
    };
    const missingDriver = selectWorkspaceSyncTargetDriver(deps, missingTransportRetained);
    await expect(missingDriver.observeCommittedTarget({ relationship, target: remoteTarget }))
      .rejects.toMatchObject({ code: 'workspace_sync_unavailable' });
  });

  it('managed_container routes readFile to openManagedNative unless workspaceSyncSourceWriterTargetRouting bypass is set', async () => {
    const managedReadFileHere = vi.fn(async () => ({
      status: 'text' as const,
      text: 'managed',
      digest: MANAGED_FILE_DIGEST,
      size: 7,
    }));
    const openManagedNative = vi.fn(async () => ({
      readFileHere: managedReadFileHere,
    }) as unknown as PrivateProjectNativeSync);
    const deps = makeTargetDriverDeps({ openManagedNative });
    const managedRetained: RetainedWorkspaceSyncPrivateExecution = {
      input: makeHandoffInput({ targetMachineId: LOCAL_MACHINE_ID }),
      phase: 'relationship',
      execution: makePrivateExecution({
        managedTarget: { workspace: makeManagedWorkspaceRef() } as WorkspaceSyncPrivateExecution['managedTarget'],
      }),
    };
    const driver = selectWorkspaceSyncTargetDriver(deps, managedRetained);

    const request = {
      relationshipId: 'rel-1',
      targetMachineId: LOCAL_MACHINE_ID,
      targetWorkspaceRefId: 'ws-managed',
      path: 'README.md',
      maxBytes: 1024,
    };

    const fromManaged = await driver.readFile(request);
    expect(fromManaged).toEqual({ status: 'text', text: 'managed', digest: MANAGED_FILE_DIGEST, size: 7 });
    expect(openManagedNative).toHaveBeenCalledWith('rel-1', 'ws-managed');
    expect(deps.targetAuthority.readFileAtTarget).not.toHaveBeenCalled();

    openManagedNative.mockClear();
    await driver.readFile(request, { workspaceSyncSourceWriterTargetRouting: true } as never, true);
    expect(openManagedNative).not.toHaveBeenCalled();
    expect(deps.targetAuthority.readFileHere).toHaveBeenCalledTimes(1);
  });
});

describe('Rank 7 Phase 1 — readReviewedExternalActionInput parity', () => {
  const secretKey = new Uint8Array(32).fill(7);
  const material = { type: 'dataKey' as const, machineKey: secretKey, publicKey: new Uint8Array(32).fill(8) };
  const baseBinding = {
    serverIdentityId: SERVER_ID,
    accountId: 'acct-1',
    actionId: 'projects.session.open' as const,
    requestId: 'req-1',
    target: { kind: 'machine' as const, machineId: LOCAL_MACHINE_ID },
    authentication: { kind: 'account' as const, tokenEpoch: 1 },
  };

  function makeAuthorization(
    envelope: Parameters<typeof computeExternalActionRequestEnvelopeDigestV1>[0],
    options: Readonly<{
      attachCustody?: boolean;
      encryptionServerId?: string | null;
      overrideDigest?: string;
    }> = {},
  ): ExternalActionExecutionAuthorizationV1 {
    const parsed = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'tok-auth',
      binding: {
        ...baseBinding,
        machineId: LOCAL_MACHINE_ID,
        installationId: 'inst-1',
        custodianAccountId: 'acct-1',
        admittedMachineRole: 'manage',
        accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: options.overrideDigest ?? computeExternalActionRequestEnvelopeDigestV1(envelope),
      },
    });
    const projection = {
      accountId: 'acct-1',
      serverId: SERVER_ID,
      accountEncryptionMode: 'e2ee' as const,
    } as unknown as ExternalActionRequesterAccountProjectionV1;
    const auth: ExternalActionExecutionAuthorizationV1 = {
      ...parsed,
      requesterAccountProjection: projection,
    };
    if (options.attachCustody !== false) {
      const encryptionServerId = options.encryptionServerId === undefined ? SERVER_ID : options.encryptionServerId;
      Object.defineProperty(projection, requesterActionContext, {
        value: {
          authorization: auth,
          credentials: { token: 'tok', encryption: material },
          serverHttpBaseUrl: 'https://home.example.test',
          isCurrent: async () => true,
          resolveEncryption: async () => encryptionServerId
            ? { serverIdentityId: encryptionServerId, material }
            : null,
        },
        enumerable: false,
      });
    }
    return auth;
  }

  it('opens valid V1 and V2 sealed envelopes with identical input semantics', async () => {
    const payload = { workspace: { serverId: SERVER_ID, refId: 'ws-alpha' } };

    const v1Envelope = { v: 1 as const, requestId: baseBinding.requestId, target: baseBinding.target, input: payload };
    const v1Auth = makeAuthorization(v1Envelope);
    let refused: string | undefined;
    expect(await readReviewedExternalActionInput({
      authorization: v1Auth,
      envelope: v1Envelope,
      onRefused: r => { refused = r; },
    })).toEqual(payload);
    expect(refused).toBeUndefined();

    const v2Envelope = sealExternalActionRequestV2({
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: baseBinding,
      material,
      randomBytes: tweetnacl.randomBytes,
      input: payload,
    });
    const v2Auth = makeAuthorization(v2Envelope);
    expect(await readReviewedExternalActionInput({
      authorization: v2Auth,
      envelope: v2Envelope,
      onRefused: r => { refused = r; },
    })).toEqual(payload);
    expect(refused).toBeUndefined();
  });

  it('reports canonical refusal reasons for invalid envelope, missing custody, binding mismatch, and unavailable encryption', async () => {
    const v2Envelope = sealExternalActionRequestV2({
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: baseBinding,
      material,
      randomBytes: tweetnacl.randomBytes,
      input: { secret: 'never-leak' },
    });

    const reasons: string[] = [];
    const capture = (r: string) => { reasons.push(r); };

    expect(await readReviewedExternalActionInput({
      authorization: makeAuthorization(v2Envelope),
      envelope: { bad: true },
      onRefused: capture,
    })).toBeNull();

    expect(await readReviewedExternalActionInput({
      authorization: makeAuthorization(v2Envelope, { attachCustody: false }),
      envelope: v2Envelope,
      onRefused: capture,
    })).toBeNull();

    expect(await readReviewedExternalActionInput({
      authorization: makeAuthorization(v2Envelope, { overrideDigest: 'A'.repeat(43) }),
      envelope: v2Envelope,
      onRefused: capture,
    })).toBeNull();

    expect(await readReviewedExternalActionInput({
      authorization: makeAuthorization(v2Envelope, { encryptionServerId: null }),
      envelope: v2Envelope,
      onRefused: capture,
    })).toBeNull();

    expect(await readReviewedExternalActionInput({
      authorization: makeAuthorization(v2Envelope, { encryptionServerId: 'wrong-server' }),
      envelope: v2Envelope,
      onRefused: capture,
    })).toBeNull();

    expect(reasons).toEqual([
      'root_envelope_invalid',
      'root_custody_unavailable',
      'root_binding_mismatch',
      'root_encryption_unavailable',
      'root_encryption_unavailable',
    ]);
  });
});

describe('Rank 7 Phase 1 — WorkspaceSyncTargetAuthority active ingress cleanup propagation', () => {
  it('propagates ingress close rejections and preserves retained native custody until ingress teardown succeeds', async () => {
    const target = makeManagedWorkspaceRef({
      id: 'ws-native-ingress',
      managedId: 'box-ingress-1',
      controller: { machineId: LOCAL_MACHINE_ID, installationId: 'inst-local' },
      rootPath: '/workspace/native-ingress',
    });
    const source = makeHostWorkspaceRef({
      id: 'ws-source-ingress',
      machineId: REMOTE_MACHINE_ID,
      rootPath: '/work/source-ingress',
    });
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const relationship: WorkspaceSyncRelationshipV1 = {
      v: 1,
      relationshipId: 'rel-native-ingress',
      controllerMachineId: REMOTE_MACHINE_ID,
      alphaWorkspaceRefId: source.id,
      betaWorkspaceRefId: target.id,
      mode: 'keep_synced',
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      contentPolicy,
    };
    const snapshot = {
      source: 'network' as const,
      accountMode: 'plain' as const,
      workspaceRefs: [source, target],
      relationships: [relationship],
      organizations: [],
      rows: [],
      graphRevision: 1,
      loadedAtMs: 1,
      scopeKey: 'owner',
    };
    const releaseAllRetainedBootstraps = vi.fn(async () => undefined);
    const nativeStub = {
      prepareBootstrapHere: vi.fn(async () => ({
        v: 1 as const,
        bootstrapOperationId: relationship.relationshipId,
        targetWorkspaceRefId: target.id,
        state: 'ready' as const,
        created: true,
        rootFingerprint: ROOT_FINGERPRINT,
        policyDigest: contentPolicy.policyDigest,
      })),
      authorizeWorkspaceSyncMachineAgent: vi.fn(async () => ({
        operationId: relationship.relationshipId,
        role: 'target' as const,
        workspaceRefId: target.id,
        canonicalRoot: target.rootPath,
      })),
      replaceSnapshot: vi.fn(async () => undefined),
      reconcileRetainedBootstraps: vi.fn(async () => undefined),
      releaseAllRetainedBootstraps,
    };
    let shouldFailStop = true;
    const stopSpy = vi.fn(async () => {
      if (shouldFailStop) throw new Error('native ingress close failed');
    });

    const authority = createWorkspaceSyncTargetAuthority({
      localServerId: SERVER_ID,
      localMachineId: LOCAL_MACHINE_ID,
      localAccountId: 'acct-owner',
      getProjectSnapshot: () => snapshot,
      callMachineRpc: async () => { throw new Error('No Machine RPC expected'); },
      resolveNativeTargetExecution: async () => nativeStub as unknown as WorkspaceSyncNativeTargetExecution,
      openNativeRootedAgent: async () => ({ stream: new PassThrough(), stop: stopSpy }),
      bootstrap: { materializationDirectory: '/tmp/unused-native-ingress-test', rootOwnershipManager: {} as never },
    });

    await authority.prepareBootstrapHere({
      v: 1,
      bootstrapOperationId: relationship.relationshipId,
      owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
      targetWorkspaceRefId: target.id,
      endpointRole: 'beta',
      policyDigest: contentPolicy.policyDigest,
      createIfMissing: true,
    });

    await authority.acquireWorkspaceSyncMachineIngress({
      operationId: relationship.relationshipId,
      sourceMachineId: REMOTE_MACHINE_ID,
      targetMachineId: LOCAL_MACHINE_ID,
    });

    // Rejecting ingress close MUST propagate and MUST NOT release or delete the retained native entry
    await expect(authority.releaseNativeTargetExecution({ target })).rejects.toThrow('native ingress close failed');
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(releaseAllRetainedBootstraps).not.toHaveBeenCalled();

    // Once ingress teardown succeeds, the still-retained native entry releases cleanly
    shouldFailStop = false;
    await expect(authority.releaseNativeTargetExecution({ target })).resolves.toBeUndefined();
    expect(releaseAllRetainedBootstraps).toHaveBeenCalledTimes(1);
  });
});

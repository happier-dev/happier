import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { SessionHandoffMetadataV2, SessionHandoffStartRequest, TransferEndpointCandidate } from '@happier-dev/protocol';

import { prepareDeferredDirectPeerStart } from './startDeferredDirectPeer';

describe('prepareDeferredDirectPeerStart', () => {
  it('exposes direct-peer endpoint candidates for deferred no-workspace starts when server-routed fallback exists', async () => {
    const request: SessionHandoffStartRequest = {
      sessionId: 'sess_deferred_direct_peer_no_workspace',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    };
    const directPeerEndpointCandidate: TransferEndpointCandidate = {
      kind: 'http',
      url: 'http://127.0.0.1:46001/machine-transfers/direct/deferred-provider',
      authorizationToken: 'deferred-provider-token',
      expiresAt: Date.now() + 60_000,
    };
    const deferredHandoffMetadataV2: SessionHandoffMetadataV2 = {};

    const sourceExportStoreSave = vi.fn(async () => undefined);
    const waitForPersistedSourceExport = vi.fn(async () => null);
    const exportSessionBundle = vi.fn(async () => ({
      agentBundle: {
        agentId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: Buffer.from('{}', 'utf8').toString('base64'),
      } as const,
      targetPath: '/repo-source',
    }));
    let preparedAgentBundleTransferPublication:
      | NonNullable<SessionHandoffMetadataV2['agentBundleTransferPublication']>
      | undefined;
    const prepareStartedState = vi.fn(async (input: Readonly<{
      preExportedAgentBundle?: Readonly<{
        agentBundleTransferPublication: NonNullable<SessionHandoffMetadataV2['agentBundleTransferPublication']>;
      }>;
    }>) => {
      preparedAgentBundleTransferPublication =
        input.preExportedAgentBundle?.agentBundleTransferPublication;
    });
    const recordDeferredStartFailure = vi.fn();

    const prepared = await prepareDeferredDirectPeerStart({
      activeServerDir: '/tmp/happier-session-handoff-deferred-direct-peer-test',
      handoffId: 'handoff_deferred_direct_peer_no_workspace',
      request,
      metadata: {
        machineId: 'machine_source',
        path: '/repo-source',
        flavor: 'claude',
        claudeSessionId: 'claude_session_source',
      },
      hasServerRoutedFallback: true,
      directPeerTransfer: {
        publishTransfer: vi.fn(async () => [directPeerEndpointCandidate]),
        requestPayloadFile: vi.fn(async ({ destinationPath }: Readonly<{ destinationPath: string }>) => ({
          destinationPath,
        })),
        clearPublishedTransfer: vi.fn(),
      },
      deferredHandoffMetadataV2,
      sourceExportStore: {
        writeAgentBundleFile: vi.fn(async () => {
          throw new Error('writeAgentBundleFile should not be called for carrier direct-peer fallback path');
        }),
        save: sourceExportStoreSave,
      },
      waitForPersistedSourceExport,
      exportSessionBundle,
      prepareStartedState,
      sourceStopState: 'already_inactive',
      recordDeferredStartFailure,
      claimMaintenance: {
        throwIfLost: () => undefined,
        race: async <T>(startEffect: () => T | PromiseLike<T>) => await startEffect(),
      } as never,
    });

    expect(prepared.deferredStartEndpointCandidates.length).toBeGreaterThan(0);
    expect(deferredHandoffMetadataV2.agentBundleTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);

    await prepared.deferredStartWorkPromise;
    expect(recordDeferredStartFailure).not.toHaveBeenCalled();
    expect(prepareStartedState).toHaveBeenCalledTimes(1);
    expect(preparedAgentBundleTransferPublication).toBeDefined();
    expect(deferredHandoffMetadataV2.agentBundleTransferPublication).toMatchObject({
      sizeBytes: preparedAgentBundleTransferPublication!.sizeBytes,
      manifestHash: preparedAgentBundleTransferPublication!.manifestHash,
    });
    expect(sourceExportStoreSave).not.toHaveBeenCalled();
    expect(waitForPersistedSourceExport).not.toHaveBeenCalled();
  });
});

import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { SessionHandoffMetadataV2, SessionHandoffStartRequest, TransferEndpointCandidate } from '@happier-dev/protocol';

import { prepareDeferredDirectPeerStart } from './rpcHandlers.sessionHandoff.startDeferredDirectPeer';

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
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: Buffer.from('{}', 'utf8').toString('base64'),
      } as const,
      targetPath: '/repo-source',
    }));
    const prepareStartedHandoffState = vi.fn(async () => undefined);
    const resolveSourceStopState = vi.fn(async () => 'already_inactive' as const);
    const recordDeferredStartFailure = vi.fn();

    const prepared = await prepareDeferredDirectPeerStart({
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
        writeProviderBundleFile: vi.fn(async () => {
          throw new Error('writeProviderBundleFile should not be called for carrier direct-peer fallback path');
        }),
        save: sourceExportStoreSave,
      },
      waitForPersistedSourceExport,
      exportSessionBundle,
      prepareStartedHandoffState,
      resolveSourceStopState,
      recordDeferredStartFailure,
    });

    expect(prepared.deferredStartEndpointCandidates.length).toBeGreaterThan(0);
    expect(deferredHandoffMetadataV2.providerBundleTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);

    await prepared.deferredStartWorkPromise;
    expect(recordDeferredStartFailure).not.toHaveBeenCalled();
    expect(prepareStartedHandoffState).toHaveBeenCalledTimes(1);
    expect(sourceExportStoreSave).not.toHaveBeenCalled();
    expect(waitForPersistedSourceExport).not.toHaveBeenCalled();
  });
});

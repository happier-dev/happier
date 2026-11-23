import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { computeHomeQrBindingProofV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  configureConnectedServerSocketBoundary,
  installDisconnectedServerSocketBoundary,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const modal = vi.hoisted(() => ({
  boundary: null as ReturnType<
    typeof import('@/dev/testkit/mocks/modal').createModalModuleMock
  > | null,
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  modal.boundary = createModalModuleMock();
  return modal.boundary.module;
});
// Entropy is a genuine system boundary; this pins the pairing binding proof.
vi.mock('@/platform/cryptoRandom', () => ({
  getRandomBytes: (size: number) => new Uint8Array(size).fill(7),
}));

// Only the Home network, device credential store, Socket.IO transport, entropy and modal host are replaced.
// The Action executor, approval Artifact, decision hook, pairing owner and reveal run for real.
const home = createHomeGovernanceHarness();
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary((socket) => {
  configureConnectedServerSocketBoundary(socket);
});
const [{ createDefaultActionExecutor }, { useApprovalDecisionHandler }] =
  await Promise.all([
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('./useApprovalDecisionHandler'),
  ]);

async function addPairingHome() {
  const identity = 'srv_pairing-home';
  const serverUrl = 'https://pairing.example';
  const serverId = await home.addHome({
    name: 'Pairing Home',
    serverUrl,
    serverIdentityId: identity,
    accountId: 'alice',
  });
  const descriptor = {
    v: 1 as const,
    homeServerIdentityId: identity,
    canonicalServerUrl: serverUrl,
    revision: 1,
    endpoints: [{ kind: 'https' as const, url: serverUrl }],
  };
  const { adoptHomeProfile } =
    await import('@/sync/domains/server/serverProfiles');
  await adoptHomeProfile({ descriptor, source: 'manual' });
  const features = {
    ...createRootLayoutFeaturesResponse({
      capabilities: { serverIdentity: { serverIdentityId: identity } },
      features: {
        auth: {
          pairing: {
            boundQrV2: { enabled: true },
            desktopQrMobileScan: { enabled: false },
          },
        },
      },
    }),
    homeConnectionDescriptor: descriptor,
  };
  const { primeServerFeaturesSnapshot } =
    await import('@/sync/api/capabilities/serverFeaturesClient');
  primeServerFeaturesSnapshot({
    serverId,
    snapshot: { status: 'ready', features, serverIdentityId: identity },
  });
  home.answer(serverId, '/v1/features', { body: features });
  home.answer(serverId, '/v1/features/authenticated', { body: features });
  const expiresAtMs = Date.now() + 60_000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  home.answer(serverId, '/v1/auth/pairing/start', {
    body: { pairId: 'pair', expiresAt },
  });
  const requesterPublicKey = new Uint8Array(32).fill(9);
  let releaseStatus!: () => void;
  const heldStatus = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  home.answer(serverId, '/v1/auth/pairing/status?pairId=pair', {
    respondAfter: heldStatus,
    body: {
      state: 'requested',
      pairId: 'pair',
      expiresAt,
      requestedPublicKey: encodeBase64(requesterPublicKey),
      requestedDeviceLabel: 'Computer',
      homeServerIdentityId: identity,
      bindingProof: computeHomeQrBindingProofV2({
        direction: 'trusted_home_displays',
        qrSecret: new Uint8Array(32).fill(7),
        pairId: 'pair',
        homeServerIdentityId: identity,
        requesterPublicKey,
        expiresAtMs,
      }),
    },
  });
  home.answer(serverId, '/v1/auth/pairing/consume', { body: {} });
  return { serverId, releaseStatus };
}

beforeEach(async () => {
  webLocks = installWebLockManagerMock();
  await home.reset();
  modal.boundary?.spies.show.mockClear();
});
afterEach(async () => {
  standardCleanup();
  const { serverScopedRpcSocketPool } =
    await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  const { resetScopedMachineTransportCacheForTests } =
    await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
  serverScopedRpcSocketPool.resetForTests();
  resetScopedMachineTransportCacheForTests();
  webLocks?.restore();
  webLocks = undefined;
});

describe('approved pairing link reveal', () => {
  // Owner decision 2026-11-23: an agent may create the link; it reaches only the person's app.
  it('shows an agent-requested pairing link to the approving person and never to the requester', async () => {
    const { serverId, releaseStatus } = await addPairingHome();
    const cancellation = new AbortController();
    const requested = createDefaultActionExecutor().execute(
      'machines.pairing.create',
      { serverId },
      {
        surface: 'agent',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        serverId,
        actionRequestId: 'agent-pairing-link',
        signal: cancellation.signal,
      },
    );
    try {
      const artifactId = await vi.waitFor(() => {
        const stored = home
          .requestsFor('/v1/artifacts')
          .find((request) => request.input !== null)?.input;
        if (
          !stored ||
          typeof stored !== 'object' ||
          !('id' in stored) ||
          typeof stored.id !== 'string'
        ) {
          throw new Error('pairing_approval_not_created');
        }
        expect(
          home.artifacts(serverId).readPlainBody(stored.id),
        ).not.toBeNull();
        return stored.id;
      });
      const approval = ApprovalRequestSchema.parse(
        JSON.parse(home.artifacts(serverId).readPlainBody(artifactId)!),
      );
      const hook = await renderHook(() =>
        useApprovalDecisionHandler(
          { id: artifactId, header: null },
          approval,
          '',
          serverId,
        ),
      );
      expect(await hook.getCurrent()('approve')).toBe(true);
      await vi.waitFor(() =>
        expect(modal.boundary?.spies.show).toHaveBeenCalledOnce(),
      );
      const shown = modal.boundary?.spies.show.mock.calls[0]?.[0] as {
        props: { url: string };
      };
      expect(shown.props.url).toMatch(/pair/);
      const requesterResult = await requested;
      expect(JSON.stringify(requesterResult)).not.toContain(shown.props.url);
      expect(home.artifacts(serverId).readPlainBody(artifactId)).not.toContain(
        shown.props.url,
      );
      await hook.unmount();
    } finally {
      releaseStatus();
      cancellation.abort();
      await requested;
    }
  });
});

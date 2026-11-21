import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
  MachineReachabilityInspectResultV1Schema,
  MachineReachabilityPlanV1Schema,
  MachineReachabilityChangeV1Schema,
} from '@happier-dev/protocol';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      confirmResult: true,
    }).module,
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineNetworkReview } = await import('./useMachineNetworkReview');
const { storage } = await import('@/sync/domains/state/storageStore');
const baseline = storage.getState();
let serverId: string;
const requests: Array<Readonly<{ actionId: string; input: unknown }>> = [];
const executions: Record<string, unknown> = {};

function readEnvelope(body: unknown) {
  const direct = ExternalActionRequestEnvelopeV1Schema.safeParse(body);
  return direct.success
    ? direct.data
    : ExternalActionRequestEnvelopeV1Schema.parse(
        ExternalActionExecutionAuthorizationRequestV1Schema.parse(body)
          .envelope,
      );
}

beforeEach(async () => {
  await homes.reset();
  requests.length = 0;
  serverId = await homes.addHome({
    name: 'Network review',
    serverUrl: 'https://network-review.test',
    serverIdentityId: 'srv_network_review',
    accountId: 'network-owner',
    currentAccount: true,
  });
  const row = {
    ...createPlainMachineRowFixture({
      id: 'network-machine',
      accountId: 'network-owner',
    }),
    installationId: 'installation-a',
  };
  homes.answer(serverId, 'POST /v1/machines/read-batch', {
    select: async (body) => ({
      body: await createMachineReadBatchResponseFixture(body, () => row).json(),
    }),
  });
  for (const actionId of [
    'machines.reachability.inspect',
    'machines.reachability.configure',
  ]) {
    const path = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${path}/execution-authorization`, {
      select: (body) => {
        const envelope = readEnvelope(body);
        return {
          body: {
            v: 1,
            token: 'network-action-proof',
            binding: {
              serverIdentityId: 'srv_network_review',
              accountId: 'network-owner',
              authentication: { kind: 'account', tokenEpoch: 0 },
              actionId,
              requestId: envelope.requestId,
              target: { kind: 'machine', machineId: 'network-machine' },
              machineId: 'network-machine',
              installationId: 'installation-a',
              custodianAccountId: 'network-owner',
              accountEncryptionMode: 'plain',
              requestEnvelopeDigest:
                computeExternalActionRequestEnvelopeDigestV1(envelope),
            },
          },
        };
      },
    });
    homes.answer(serverId, path, {
      select: (body) => {
        const envelope = readEnvelope(body);
        requests.push({ actionId, input: envelope.input });
        return {
          body: {
            v: 1,
            actionId,
            requestId: envelope.requestId,
            execution: executions[actionId],
          },
        };
      },
    });
  }
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
  storage.setState(baseline, true);
});

const posture = {
  revision: 3,
  management: { providers: [], publicSsh: { kind: 'closed' } },
  defaultServiceIngress: { kind: 'none' },
} as const;
const change = MachineReachabilityChangeV1Schema.parse({ kind: 'posture', posture });
const plan = MachineReachabilityPlanV1Schema.parse({
  reviewedPlanDigest: 'c'.repeat(64),
  basis: {
    machineId: 'network-machine',
    installationId: 'installation-a',
    currentSelections: [],
    currentPostureRevision: 3,
    change,
    occurrences: [],
    recipePlans: [],
  },
});
const inspected = MachineReachabilityInspectResultV1Schema.parse({
  machineId: 'network-machine',
  metadataVersion: 4,
  posture,
  selections: [],
  observation: {
    revision: 7,
    management: { daemon: 'ready', providers: [], publicSsh: 'closed' },
    privateNetworks: [],
    ingress: [],
  },
  plan,
});

describe('Machine → Network reviewed change', () => {
  it('reviews an initial posture with revision zero', async () => {
    const initial = MachineReachabilityChangeV1Schema.parse({ kind: 'posture', posture: {
      ...posture, revision: 0,
    } });
    const reviewedPlan = MachineReachabilityPlanV1Schema.parse({ ...plan, basis: {
      ...plan.basis, currentPostureRevision: null, change: initial,
    } });
    executions['machines.reachability.inspect'] = { ok: true, result: {
      ...inspected, posture: null, plan: reviewedPlan,
    } };
    const hook = await renderHook(() => useMachineNetworkReview({ serverId, machineId: 'network-machine' }));
    try {
      await act(async () => { await hook.getCurrent().prepare(initial, null); });
      expect(requests[0]?.input).toEqual({ serverId, machineId: 'network-machine', change: initial });
      expect(hook.getCurrent().review).toMatchObject({ kind: 'review', plan: reviewedPlan });
    } finally { await hook.unmount(); }
  });

  it('prepares the #83 saved revision-zero SSH draft at the next posture revision, including a repeated review', async () => {
    // MACH-QA-NET-83/owner-inspect.json: metadata 87, observation 14,
    // saved posture 0. Observation/metadata versions do not version this draft.
    const saved = MachineReachabilityChangeV1Schema.parse({ kind: 'posture', posture: {
      revision: 0, management: { providers: [], publicSsh: {
        kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0', '::/0'],
      } }, defaultServiceIngress: { kind: 'none' },
    } });
    if (saved.kind !== 'posture') throw new Error('Expected captured posture');
    const draft = { kind: 'posture' as const, posture: { ...saved.posture,
      management: { ...saved.posture.management, publicSsh: { kind: 'closed' as const } } } };
    const next = { ...draft, posture: { ...draft.posture, revision: 1 } };
    const reviewedPlan = MachineReachabilityPlanV1Schema.parse({ ...plan, basis: {
      ...plan.basis, currentPostureRevision: 0, change: next,
    } });
    executions['machines.reachability.inspect'] = { ok: true, result: {
      ...inspected, metadataVersion: 87, posture: saved.posture,
      observation: { ...inspected.observation, revision: 14,
        management: { daemon: 'ready', providers: [], publicSsh: 'open' }, privateNetworks: [] },
      plan: reviewedPlan,
    } };
    const hook = await renderHook(() => useMachineNetworkReview({ serverId, machineId: 'network-machine' }));
    try {
      await act(async () => { await hook.getCurrent().prepare(draft); });
      expect(requests[0]?.input).toMatchObject({ change: next });
      expect(hook.getCurrent().review).toMatchObject({ kind: 'review', plan: reviewedPlan });
      await act(async () => { hook.getCurrent().cancel(); });
      await act(async () => { await hook.getCurrent().prepare(draft); });
      expect(requests.map(request => request.input)).toEqual([
        { serverId, machineId: 'network-machine', change: next },
        { serverId, machineId: 'network-machine', change: next },
      ]);
      expect(draft.posture.revision).toBe(0);
    } finally { await hook.unmount(); }
  });

  it.each([
    { scenario: 'posture', change },
    { scenario: 'private-network Join', change: MachineReachabilityChangeV1Schema.parse({
      kind: 'privateNetwork', intent: 'join', selection: {
        provider: { kind: 'builtin', id: 'tailscale' }, config: { profile: 'work' }, credentialRefs: [],
      },
    }) },
  ])('applies exactly the host-reviewed $scenario plan once; waiting for approval leaves no second Apply', async ({ change }) => {
    const proposedChange = change.kind === 'posture'
      ? { ...change, posture: { ...change.posture, revision: change.posture.revision + 1 } } : change;
    const reviewedPlan = MachineReachabilityPlanV1Schema.parse({ ...plan, basis: { ...plan.basis, change: proposedChange } });
    executions['machines.reachability.inspect'] = {
      ok: true,
      result: { ...inspected, plan: reviewedPlan },
    };
    executions['machines.reachability.configure'] = {
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'network-approval',
        actionId: 'machines.reachability.configure',
      },
    };
    const hook = await renderHook(() =>
      useMachineNetworkReview({ serverId, machineId: 'network-machine' }),
    );
    try {
      await act(async () => {
        await hook.getCurrent().prepare(change);
      });
      expect(hook.getCurrent().review).toMatchObject({
        kind: 'review',
        plan: { reviewedPlanDigest: reviewedPlan.reviewedPlanDigest },
      });
      expect(requests).toEqual([
        {
          actionId: 'machines.reachability.inspect',
          input: { serverId, machineId: 'network-machine', change: proposedChange },
        },
      ]);

      await act(async () => {
        void hook.getCurrent().apply();
      });
      await vi.waitFor(() =>
        expect(hook.getCurrent().review).toMatchObject({
          kind: 'applying',
          approval: { artifactId: 'network-approval' },
        }),
      );
      await act(async () => {
        await hook.getCurrent().apply();
      });
      const configures = requests.filter(
        (request) => request.actionId === 'machines.reachability.configure',
      );
      expect(configures).toHaveLength(1);
      expect(configures[0]?.input).toMatchObject({
        reviewedPlanDigest: reviewedPlan.reviewedPlanDigest,
        reviewedPlanBasis: reviewedPlan.basis,
        change: proposedChange,
      });
    } finally {
      await hook.unmount();
    }
  });

  it('keeps a typed refusal visible with its reviewed plan instead of reporting success', async () => {
    executions['machines.reachability.inspect'] = {
      ok: true,
      result: inspected,
    };
    executions['machines.reachability.configure'] = {
      ok: false,
      errorCode: 'machine_unavailable',
      error: 'unavailable',
    };
    const hook = await renderHook(() =>
      useMachineNetworkReview({ serverId, machineId: 'network-machine' }),
    );
    try {
      await act(async () => {
        await hook.getCurrent().prepare(change);
      });
      await act(async () => {
        await hook.getCurrent().apply();
      });
      expect(hook.getCurrent().review).toMatchObject({
        kind: 'failed',
        failure: { errorCode: 'machine_unavailable' },
        plan: { reviewedPlanDigest: plan.reviewedPlanDigest },
      });
    } finally {
      await hook.unmount();
    }
  });
});

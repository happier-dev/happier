import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MachineServiceRowV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { MachineServiceAdoptResultV1 } from '@happier-dev/protocol/actions/specs/machine/serviceAdoption';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

// Transport boundaries are substituted; the sheet, its hook, the Action front door and executor stay real.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
const adoptionTransport = vi.fn();
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(machineTransport.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { MachineServiceAdoptionReview } = await import('./MachineServiceAdoptionSheet');
const { canAdoptMachineService } = await import('./machineServiceAdoptionPresentation');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { MachineServicePage } = await import('../MachineServicePage');
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');

let serverId: string;
const machineId = 'adopt-machine';
const review: MachineServiceAdoptResultV1 = {
  kind: 'review', reviewedDigest: `sha256:${'b'.repeat(64)}`, originalProfiles: 'unknown', document: 'services: {}\n',
  variables: [{ name: 'MB_SITE_URL', phase: 'runtime', required: true, hasDefault: false },
    { name: 'MB_DB_HOST', phase: 'runtime', required: false, hasDefault: true }],
  services: ['metabase', 'db'], profiles: [], availableProfiles: [],
};
const row = (overrides: Record<string, unknown> = {}) => MachineServiceRowV1Schema.parse({
  serviceId: 'analytics', name: 'analytics', authority: 'machine', lifecyclePurpose: 'development', generation: 'gen-1',
  state: 'running', watchId: 'watch-a', watchRevision: 'rev-a',
  nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'compose' }, nativeResourceId: 'analytics' },
  capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false }, ...overrides,
});

beforeEach(async () => {
  await homes.reset();
  machineTransport.rpc.mockReset();
  adoptionTransport.mockReset();
  serverId = await homes.addHome({ name: 'Adopt', serverUrl: 'https://adopt-sheet.test', serverIdentityId: 'srv_adopt_sheet',
    accountId: 'adopt-owner', currentAccount: true });
  await answerExternalActionAccountForHome(homes, serverId, { machineId, actionId: 'machines.services.adopt',
    tokenEpoch: 0, requesterInvocation: 'none', failure: parseActionExecuteFailure,
    execute: input => adoptionTransport({ payload: input }) });
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

const adoptCalls = () => adoptionTransport.mock.calls.map(([call]) => call as { payload: Record<string, unknown> });

it('keeps the producer cause visible when the review Action fails', async () => {
  adoptionTransport.mockResolvedValue({ ok: false, errorCode: 'action_failed', error: 'Private provider diagnostic',
    failureCause: { phase: 'native.review', errorClass: 'TypeError', errorCode: 'ECONNREFUSED', httpStatus: 503 } });
  const screen = await renderScreen(<MachineServiceAdoptionReview serverId={serverId} machineId={machineId}
    machineName="shop-prod" service={row()} onClose={() => {}} execute={createFrontDoorActionExecute()} />);
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.read-failed')).not.toBeNull());
  await screen.pressByTestIdAsync('machine-service-adopt.read-failed-details-toggle');
  expect(screen.getTextContent()).toContain('ECONNREFUSED');
  expect(screen.getTextContent()).not.toContain('Private provider diagnostic');
});

it('offers adoption only for a watched Compose project at a known generation', () => {
  expect(canAdoptMachineService(row())).toBe(true);
  expect(canAdoptMachineService(row({ generation: null }))).toBe(false);
  expect(canAdoptMachineService(row({ nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'x' } }))).toBe(false);
  expect(canAdoptMachineService(row({ authority: 'project', environmentId: 'env', watchId: undefined, watchRevision: undefined,
    nativeInstance: undefined }))).toBe(false);
});

it('says what changes and what does not, and adopts once every captured variable is bound', async () => {
  adoptionTransport.mockImplementation(async ({ payload }: { payload: { mode: string } }) =>
    payload.mode === 'review' ? review : { kind: 'adopted', environmentId: 'env-1', revision: 2, targetLinkId: 'link-1' });
  const onClose = vi.fn();
  const screen = await renderScreen(<MachineServiceAdoptionReview serverId={serverId} machineId={machineId}
    machineName="shop-prod" service={row()} onClose={onClose} execute={createFrontDoorActionExecute()} />);
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.variable.MB_SITE_URL')).not.toBeNull());
  const text = screen.getTextContent();
  expect(text).toContain(t('machineServices.adopt.now'));
  expect(text).toContain(t('machineServices.adopt.nowDetail', { service: 'analytics' }));
  expect(text).toContain('metabase');
  // Value-free capture: nothing is read into a field, and Adopt waits for every variable.
  expect(screen.findHostByTestId('machine-service-adopt.confirm')!.props.accessibilityState?.disabled).toBe(true);
  screen.changeTextByTestId('machine-service-adopt.value.MB_SITE_URL', 'https://stats.example.com');
  // Keystrokes are separate events: the editor sees the first binding before the next one lands.
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.value.MB_SITE_URL')!.props.value).toBe('https://stats.example.com'));
  expect(screen.findHostByTestId('machine-service-adopt.confirm')!.props.accessibilityState?.disabled).toBe(true);
  screen.changeTextByTestId('machine-service-adopt.value.MB_DB_HOST', 'db');
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.confirm')!.props.accessibilityState?.disabled).toBe(false));
  await screen.pressByTestIdAsync('machine-service-adopt.confirm');
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.adopted')).not.toBeNull());
  expect(adoptCalls()).toHaveLength(2);
  expect(adoptCalls()[1]!.payload).toMatchObject({ mode: 'apply', bindingsConfirmed: true, reviewedDigest: review.reviewedDigest,
    destination: { name: 'analytics', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      newProject: { name: 'analytics' } },
    bindings: [
      { purpose: 'variable', name: 'MB_SITE_URL', phase: 'runtime', source: { kind: 'value', value: 'https://stats.example.com' } },
      { purpose: 'variable', name: 'MB_DB_HOST', phase: 'runtime', source: { kind: 'value', value: 'db' } },
    ] });
});

it('keeps a partial adoption in its own words and continues it with Try again', async () => {
  let applies = 0;
  adoptionTransport.mockImplementation(async ({ payload }: { payload: { mode: string } }) => {
    if (payload.mode === 'review') return { ...review, variables: [] };
    applies++;
    return applies === 1
      ? { kind: 'partial', errorCode: 'outcome_unknown', preparedCreate: { serverId, requestKey: 'k', projectSourceId: 'source',
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId,
        contentArtifactId: 'c', contentHeaderVersion: 1, contentBodyVersion: 1 } }
      : { kind: 'adopted', environmentId: 'env-1', revision: 2, targetLinkId: 'link-1' };
  });
  const screen = await renderScreen(<MachineServiceAdoptionReview serverId={serverId} machineId={machineId}
    machineName="shop-prod" service={row()} onClose={() => {}} execute={createFrontDoorActionExecute()} />);
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.confirm')!.props.accessibilityState?.disabled).toBe(false));
  await screen.pressByTestIdAsync('machine-service-adopt.confirm');
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.partial')).not.toBeNull());
  expect(screen.getTextContent()).toContain(t('machineServices.adopt.partialBody', { service: 'analytics' }));
  // The continuation re-sends exactly what was applied, so nothing on screen may suggest it can still be edited.
  expect(screen.findHostByTestId('machine-service-adopt.name')).toBeNull();
  await screen.pressByTestIdAsync('machine-service-adopt.retry');
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt.adopted')).not.toBeNull());
  expect(adoptCalls()[2]!.payload).toEqual(adoptCalls()[1]!.payload);
});

it('leads a watched Compose project\'s page with Adopt and says what watching cannot do, never for a deployed one', async () => {
  machineTransport.rpc.mockImplementation(async ({ method }: { method: string }) =>
    method === RPC_METHODS.MACHINES_SERVICE_DETAIL ? { kind: 'service', service: row() } : { kind: 'unavailable', reason: 'machine_unreachable' });
  const page = (service: ReturnType<typeof row>) => (
    <AccountNoticeInvestigationBoundary>
      <MachineServicePage serverId={serverId} machineId={machineId} machineName="shop-prod"
        serviceId={service.serviceId} service={service} list="listed" online readAt={1} refreshing={false} onRetry={() => {}}
        active onBack={() => {}} />
    </AccountNoticeInvestigationBoundary>
  );
  const screen = await renderScreen(page(row()));
  await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-adopt')).not.toBeNull());
  expect(screen.getTextContent()).toContain(t('machineServices.adopt.watchedNote', { service: 'analytics' }));
  const deployed = await renderScreen(page(row({ authority: 'project', environmentId: 'env', watchId: undefined, watchRevision: undefined,
    nativeInstance: undefined })));
  await vi.waitFor(() => expect(deployed.findHostByTestId('machine-service-page')).not.toBeNull());
  expect(deployed.findHostByTestId('machine-service-adopt')).toBeNull();
});

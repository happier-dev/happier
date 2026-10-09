import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Metro's lazy module loader is the boundary here; the real Action front door still executes.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

const preset = (id: string, name: string) => ({
  id,
  homeId: 'srv_build',
  revision: 2,
  name,
  owner: { kind: 'account', accountId: 'owner' },
  recipe: {
    provider: { pluginId: 'custom.compute', localId: 'native' },
    schemaVersion: 1,
    name,
    choices: {},
  },
  controller: { machineId: 'controller', installationId: 'installation' },
  environment: {
    toolchain: { adapterId: 'mise', config: '[tools]' },
    setupScript: 'npm ci\nnpm run build',
  },
});

describe('Set up from a preset (D53)', () => {
  it('shows what a chosen preset sets up and runs it only from the one Set up button', async () => {
    const home = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    harness.answer(home, '/v1/machines/presets/list', {
      body: {
        kind: 'listed',
        presets: [preset('web', 'Web box'), preset('build', 'Build box')],
      },
    });
    const { MachineEnvironmentApplySheet } =
      await import('./MachineEnvironmentApplySheet');
    // The Action front door first resolves the target machine through the Home; choosing never gets that far.
    const frontDoorReads = () =>
      harness.requests.filter((request) => request.path === '/v1/machines');
    const screen = await renderScreen(
      <MachineEnvironmentApplySheet
        serverId={serverId}
        machineId="devbox"
        machineName="devbox"
        onClose={vi.fn()}
        setChrome={vi.fn()}
        {...({} as never)}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(node => node.props?.testID === 'machine-environment-apply.preset:build').length,
      ).toBeGreaterThan(0),
    );
    const run = () =>
      screen.tree.findAll(
        (node) =>
          node.props?.testID === 'machine-environment-apply.run' &&
          typeof node.props.onPress === 'function',
      )[0]!;
    // Two presets: nothing is chosen yet, so nothing can run.
    expect(run().props.disabled).toBe(true);
    const row = screen.tree.findAll(
      (node) =>
        node.props?.testID === 'machine-environment-apply.preset:build' &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => row.props.onPress());
    // Choosing reveals the labelled facts and sends nothing.
    const chosenRow = screen.tree.findAll(
      (node) => node.props?.testID === 'machine-environment-apply.preset:build' && typeof node.props.subtitle === 'string',
    )[0]!;
    expect(chosenRow.props.subtitle).toContain('\n');
    expect(chosenRow.props.subtitle).toContain('2');
    expect(frontDoorReads()).toHaveLength(0);
    expect(run().props.disabled).toBe(false);
    await act(async () => run().props.onPress());
    await waitForHomeGovernance(() => expect(frontDoorReads().length).toBeGreaterThan(0));
    await screen.unmount();
  });
});

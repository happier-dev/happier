import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
  PluginProjectedComposerControlEntryV1Schema,
  PluginProjectedComposerRegionEntryV1Schema,
  PluginProjectionV2Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createMachineFixture,
  renderScreen as renderPanelScreen,
} from '@/dev/testkit';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

installAgentInputCommonModuleMocks();

/** The plugin UI sandbox is the external boundary; the mounted-region count shows what survives activation. */
const regionHosts = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
  PluginSurfaceHost: () => {
    React.useEffect(() => {
      regionHosts.mounts += 1;
    }, []);
    return React.createElement('PluginSurfaceHost', {
      testID: 'plugin-region-host',
    });
  },
}));

const identity = { pluginId: 'acme.compose', localId: 'summary' };
const control = PluginProjectedComposerControlEntryV1Schema.parse({
  id: 'acme.compose/refresh',
  pluginId: 'acme.compose',
  identity: { pluginId: 'acme.compose', localId: 'refresh' },
  occurrenceId: 'generation-1',
  definition: {
    id: 'refresh',
    label: 'Refresh',
    icon: 'preview',
      defaultPlacement: 'pinned',
    interaction: { kind: 'action', action: 'refresh' },
  },
});
const region = PluginProjectedComposerRegionEntryV1Schema.parse({
  id: 'acme.compose/summary',
  pluginId: 'acme.compose',
  identity,
  occurrenceId: 'generation-1',
  definition: {
    id: 'summary',
    placement: 'beforeComposer',
    renderer: { renderer: 'summary-renderer' },
  },
});
const catalogEntry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
  contribution: identity,
  occurrenceId: 'generation-1',
  projectionGeneration: 7,
  role: 'region',
  rendererChain: [{ pluginId: 'acme.compose', localId: 'summary-renderer' }],
  selectedRenderer: {
    identity: { pluginId: 'acme.compose', localId: 'summary-renderer' },
    renderer: { kind: 'declarative', contributionId: 'summary-renderer' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
  },
  executionOrigin: {
    serverIdentityId: 'srv_server-1',
    materializationRef: {
      machineId: 'machine-9',
      materializationId: 'materialization-1',
      pluginId: 'acme.compose',
    },
  },
  resourceCapability: { readable: true, dynamic: true },
  contributorTargetedContributions: {
    target: {
      pluginId: 'acme.compose',
      occurrenceId: 'generation-1',
      sourceCustody: { kind: 'development', registeredRootId: 'compose-root' },
    },
    points: [],
  },
});
const projection = PluginProjectionV2Schema.parse({
  v: 2,
  generation: 7,
  familiesById: {
    composerControls: {
      family: 'composerControls',
      entriesById: { [control.id]: control },
    },
    composerRegions: {
      family: 'composerRegions',
      entriesById: { [region.id]: region },
    },
  },
});

const { installSessionPaneRuntimeTestHarness } =
  await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness({
  request: async (url, init) =>
    createPlainMachineReadHttpResponseFixture(
      new URL(String(url)).pathname,
      init,
      'account-a',
    ),
  rpc: async (method) => {
    if (
      method ===
      RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    ) {
      return {
        protocolVersion: 1,
        projection,
        composerSurfaceCatalog: [catalogEntry],
      };
    }
    return {};
  },
});
const { storage } = await import('@/sync/domains/state/storageStore');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { ScopedAuthoringComposer } =
  await import('@/components/sessions/authoring/ScopedAuthoringComposer');
const { createWorkflowAuthoringComposerCustody } =
  await import('@/components/sessions/authoring/authoringComposerCustody');

const attachment = {
  v: 1 as const,
  instanceId: 'attachment-1',
  attachment: { pluginId: 'acme.issues', localId: 'issue' },
  key: 'issue-42',
  value: { issueId: 42 },
  presentation: { label: 'Issue #42', typeLabel: 'Issue' },
};

async function renderScreen(element: React.ReactElement) {
  // Match the plain Machine served by the HTTP boundary in Sync's hydrated projection too.
  storage.getState().applyMachines([createMachineFixture({ id: 'machine-9', storageMode: 'plain' })]);
  const { observeMachinePresenceForTest } =
    await import('@/dev/testkit/harness/machinePresence');
  observeMachinePresenceForTest(
    { serverId: runtime.serverId, accountId: 'account-a' },
    ['machine-9'],
  );
  return renderPanelScreen(element, { wrapper: runtime.Wrapper });
}

describe('ScopedAuthoringComposer inactive picture', () => {
  it('draws the plugin region, contributed chip and attachment the live row draws, and keeps the region through activation', async () => {
    regionHosts.mounts = 0;
    const custody = createWorkflowAuthoringComposerCustody(
      'inactive-presentation',
    ).entryFor('review-step');
    const element = (editing: boolean) => (
      <ScopedAuthoringComposer
        custody={custody}
        scope={{
          kind: 'machine',
          machineId: 'machine-9',
          serverId: runtime.serverId,
          directory: '~/code/app',
          machineHomeDir: '/Users/dev',
        }}
        document={{
          text: 'Review the diff',
          references: [],
          attachments: [attachment],
        }}
        onChangeDocument={() => {}}
        attachmentsEnabled
        placeholder="Describe the step"
        editing={editing}
        onRequestEdit={() => {}}
      />
    );
    const screen = await renderScreen(element(false));
    const chipId = `plugin-composer-control:${control.id}`;
    await vi.waitFor(() =>
      expect(screen.findHostByTestId(chipId)).not.toBeNull(),
    );

    // Picture: no live composer, the plugin's chip, tray and region all drawn.
    expect(screen.findAllByType(AgentInput)).toHaveLength(0);
    expect(
      screen.findHostByTestId('agent-input-document-preview-attachments'),
    ).not.toBeNull();
    await vi.waitFor(() =>
      expect(screen.findHostByTestId('plugin-region-host')).not.toBeNull(),
    );
    // The region sits above the composer, as it does around the live row.
    const order = screen.root.findAll(
      (node) =>
        node.props?.testID === 'plugin-region-host' ||
        node.props?.testID === 'agent-input-document-preview',
    );
    expect(order.map((node) => node.props.testID)[0]).toBe(
      'plugin-region-host',
    );
    expect(regionHosts.mounts).toBe(1);

    // Activation swaps the composer in place: the same chip and the same mounted region.
    await screen.update(element(true));
    await vi.waitFor(() =>
      expect(screen.findAllByType(AgentInput)).toHaveLength(1),
    );
    expect(screen.findHostByTestId(chipId)).not.toBeNull();
    expect(regionHosts.mounts).toBe(1);
    await screen.unmount();
  });
});

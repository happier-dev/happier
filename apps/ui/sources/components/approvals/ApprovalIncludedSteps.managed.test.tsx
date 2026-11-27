import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { PluginMachineMaterializationV1Schema, PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readIndexedBundledDeclarationManifest } from '../../../../cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from '../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';

installApprovalCommonModuleMocks({
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalIncludedSteps } = await import('./ApprovalIncludedSteps');
const { t } = await import('@/text');

it('names the reviewed Railway setup Actions from a cold Machine installation', async () => {
  const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
  const { createAppShellPluginUiProjectionPublication } = await import('@/components/appShell/plugins/appShellPluginUiProjectionPublication');
  const { createPluginAccountAvailabilityReader } = await import('@/sync/domains/plugins/availability/reader');
  standardCleanup();
  await harness.reset();
  const scope = { serverId: 'home', accountId: 'account' };
  const manifest = PluginPortableReleaseManifestV1Schema.parse(readIndexedBundledDeclarationManifest(
    new URL('../../../../cli/assets/bundled-plugin-manifests/machine-services.json', import.meta.url),
  ));
  const fullDeclaration = await projectBundledPluginUiDeclaration({
    packageName: '@happier-dev/plugins-machine-services', packageVersion: manifest.version, manifest, artifactGraphs: [],
  });
  if (!fullDeclaration) throw new Error('Machine services declaration could not be projected');
  const coldDeclaration = await projectBundledPluginUiFirstPaintDeclaration(fullDeclaration);
  const loadDeclaration = vi.fn(async () => fullDeclaration);
  const machine = PluginMachineMaterializationV1Schema.parse({
    serverIdentityId: 'srv_test', machineId: 'reviewed-machine', materializationId: 'installation',
    pluginId: manifest.id, version: manifest.version, sourceClass: 'bundledFirstParty',
    portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
  });
  const availability = createPluginAccountAvailabilityReader({ scope, snapshot: {
    availabilityCursor: 1, intentReads: [], materializations: [machine],
    snapshots: [{ serverIdentityId: machine.serverIdentityId, machineId: machine.machineId, materializations: [machine] }],
  }, hostBundledUi: [{ ...coldDeclaration, loadDeclaration }] });
  const shell = createAppShellPluginUiProjectionPublication();
  try {
    shell.publishSources({ accountLifetime: null, availabilityInputs: availability.readUiProjectionInputs(),
      hostBundledUiEnabled: true, activeServerId: scope.serverId, serverProfilesGeneration: 0,
      activeInventoryLoaded: true, onlineMachineIds: [machine.machineId], selectableMachineIds: [machine.machineId] });
    const projection = shell.getSnapshot().pluginUiProjection;
    expect(projection?.installedPackagesById[manifest.id]?.displayName).toBe('Machine services');
    const children = ['deployment-failed/setup', 'deployment-succeeded/setup'].map(localId => ({
      action: { pluginId: manifest.id, localId }, role: localId,
    }));
    for (const { action } of children) expect(projection?.actionsById[buildQualifiedPluginContributionKey(action)]).toBeUndefined();
    const screen = await renderScreen(
      <AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'establishing',
        interactionEnabled: false, machineId: null, serverId: scope.serverId, platform: 'web',
        accountLifetime: null, clientExecutableActivation: { status: 'establishing' },
        reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
      }}>
        <ApprovalIncludedSteps preview={{ hostReviewedChildren: { children } }} serverId={null} testID="steps" />
      </AppShellPluginUiProjectionValueProvider>,
    );
    expect(screen.getTextContent()).toContain('Watch for deployment failures');
    expect(screen.getTextContent()).toContain('Watch for successful deployments');
    expect(loadDeclaration).not.toHaveBeenCalled();
  } finally {
    shell.dispose();
    standardCleanup();
  }
});

describe('included retention step (P41-R31)', () => {
  beforeEach(async () => {
    standardCleanup();
    await harness.reset();
  });
  afterEach(() => standardCleanup());

  it('says the deploy keeps its managed machine always on, beside the finite rule it replaces', async () => {
    const home = await harness.addHome({
      name: 'Deploy Home',
      serverUrl: 'https://included-retention.test',
      accountId: 'account',
      serverIdentityId: 'srv_deploy',
    });
    const machine = ManagedMachineV1Schema.parse({
      id: 'managed-api',
      homeId: 'srv_deploy',
      custodianAccountId: 'account',
      controller: { machineId: 'controller', installationId: 'installed' },
      launch: {
        provider: { pluginId: 'fixture.compute', localId: 'vm' },
        schemaVersion: 1,
        name: 'API guest',
        choices: {},
      },
      allocation: 'bound',
      creationState: 'active',
      desired: 'start',
      desiredWhen: 'now',
      resource: {
        contributionRef: { pluginId: 'fixture.compute', localId: 'vm' },
        schemaVersion: 1,
        value: {},
      },
      intentRevision: 4,
      retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
      wakeOnAcceptedMessage: true,
    });
    harness.answer(home, 'POST /v1/machines/managed/actions/get', {
      body: machine,
    });
    // The host-reviewed target-enable child: the allocation's finite rule becomes until-delete.
    const preview = {
      actionId: 'deployments.targets.link',
      hostReviewedChildren: {
        children: [
          {
            action: 'machines.managed.retention.update',
            role: 'target-retention:machine-2',
            input: {
              homeId: 'srv_deploy',
              managedId: 'managed-api',
              expectedIntentRevision: 4,
              retention: { kind: 'until-delete' },
              wakeOnAcceptedMessage: true,
            },
          },
        ],
      },
    };
    const screen = await renderScreen(
      <ApprovalIncludedSteps
        preview={preview}
        serverId={home}
        testID="steps"
      />,
    );
    await flushHookEffects({ cycles: 25 });
    const text = screen.getTextContent();
    // The step reads by its outcome, never the generic "Change when a machine stops", and says what it replaces.
    expect(text).toContain(t('approvals.includedStepKeepAlwaysOn'));
    expect(text).not.toContain(
      t('actionPresentation.titles.machines_managed_retention_update'),
    );
    expect(text).toContain(
      t('approvals.includedStepRetentionNow', {
        policy: t('managedRetention.stopAfterUnused', {
          duration: t('managedRetention.hours', { count: 1 }),
        }),
      }),
    );
    expect(text).not.toContain('managed-api');
  });
});

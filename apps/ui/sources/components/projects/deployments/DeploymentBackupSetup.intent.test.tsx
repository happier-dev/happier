import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentPreviewDataSelectionV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { BackupDestinationContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/backup-destinations/src/manifest';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentBackupSetupSheet } = await import('./DeploymentBackupControls');
afterEach(standardCleanup);

type DestinationIntent = NonNullable<Extract<DeploymentPreviewDataSelectionV1, { kind: 'template' }>['destinationBackup']>;

it('authors backup destination intent with exact Saved Secret references and no Configure, Test or Initialize effect', async () => {
  const detail = { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
  const declared = PLUGIN_MANIFEST.contributes.backupDestinations?.find(entry => entry.id === 'local');
  const definition = declared ? BackupDestinationContributionV1Schema.parse(declared) : undefined;
  if (!definition) throw new Error('Expected canonical local backup destination');
  const destination = { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
    pluginVersion: PLUGIN_MANIFEST.version, definition };
  const savedSecret = { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('preview-repository'), resourceRevision: 7 };
  const { ownership: _ownership, ...configuration } = DeploymentBackupConfigurationV1Schema.parse({
    configRevision: 1, destinationRef: { pluginId: PLUGIN_MANIFEST.id, localId: definition.id }, occurrenceId: definition.id,
    config: { path: '/backups' }, sources: [{ kind: 'dump', sourceId: 'postgres-dump', service: 'postgres', consistency: 'logical' }],
    credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
    ownership: { environmentId: detail.environment.id, prefix: '' }, retention: { kind: 'keepEverything' },
  });
  const initialIntent: DestinationIntent = { configuration, prefix: 'previews', bindings: [
    { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword', source: savedSecret },
  ] };
  const selected: DestinationIntent[] = [];
  let closed = false;
  const screen = await renderScreen(<DeploymentBackupSetupSheet mode="intent" detail={detail} destination={destination}
    sourceChoices={configuration.sources} machine="Preview machine" initialIntent={initialIntent}
    onIntent={intent => selected.push(intent)} onClose={() => { closed = true; }} testID="preview.backup" />);
  try {
    expect(screen.findByTestId('preview.backup.test')).toBeNull();
    expect(screen.findByTestId('preview.backup.initialize')).toBeNull();
    expect(screen.findByTestId('preview.backup.prefix')).not.toBeNull();
    await act(async () => screen.changeTextByTestId('preview.backup.prefix', 'pull-requests'));
    await screen.pressByTestIdAsync('preview.backup.save');
    expect(selected).toEqual([{ ...initialIntent, prefix: 'pull-requests' }]);
    expect(closed).toBe(true);
    expect(homes.requests).toEqual([]);
  } finally { await screen.unmount(); }
});

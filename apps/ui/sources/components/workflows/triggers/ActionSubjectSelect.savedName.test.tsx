/** @vitest-environment jsdom */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { databaseActionMetadata } from '@happier-dev/plugin-sdk/actions';
import {
  DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1, databaseActionLocalIdV1,
} from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { act } from 'react-test-renderer';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

// The Homes' HTTP and Account credentials are the boundary; the deployment read owner, the
// private header read and the select stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ActionSubjectSelect } = await import('./ActionSubjectSelect');

describe('A reopened Action trigger names its saved resource', () => {
  let portal: ReturnType<typeof installReactDomPortalBoundaryForTests>;
  beforeEach(async () => {
    await homes.reset();
    portal = installReactDomPortalBoundaryForTests();
  });
  afterEach(() => {
    standardCleanup();
    portal.restore();
  });

  it('settles the exact subject picker when its Home has no credential binding', async () => {
    const { t } = await import('@/text');
    const screen = await renderScreen(<ActionSubjectSelect testID="subject"
      operand={{ kind: { kind: 'environment' } }} subject={undefined} machineId={null} serverId="unknown-home"
      onChange={() => {}} />);
    try {
      const menu = () => screen.findByType(DropdownMenu);
      await act(async () => menu().props.onOpenChange(true));
      await vi.waitFor(() => expect(menu().props.items).toContainEqual(expect.objectContaining({
        title: t('common.unavailable'), disabled: true,
      })));
      expect(menu().props.items).not.toContainEqual(expect.objectContaining({ title: t('common.loading') }));
      expect(homes.requests.some(request => request.path.startsWith('/v1/deployments/environments'))).toBe(false);
    } finally { await screen.unmount(); }
  });

  it('offers saved Environments as scopes for an exact Database selection', async () => {
    const serverIdentityId = 'srv_database_subject_scope';
    const machineId = 'environment-controller';
    const serverId = await homes.addHome({
      name: 'Database subject',
      serverUrl: 'https://database-subject-scope.test',
      serverIdentityId,
      accountId: 'account-owner',
      accountEncryptionMode: 'plain',
      currentAccount: true,
      active: true,
    });
    const environment = createDeploymentEnvironmentHeaderV1({
      id: 'production', serverId: serverIdentityId,
      controllerMachineId: machineId, contentArtifactId: 'database-scope-production',
    });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
      await account.createArtifactDocument({
        artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' },
        body: JSON.stringify(createDeploymentEnvironmentDetailV1({ environment }).content),
      });
    } finally {
      account.dispose();
    }
    const path = '/v1/deployments/environments';
    homes.answer(serverId, path, { body: { ok: true, items: [environment], nextCursor: null } });
    const localId = databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1);
    const metadata = databaseActionMetadata[DATABASE_TARGETS_LIST_ACTION_ID_V1];
    const executionOrigin = { serverIdentityId, materializationRef: {
      machineId, pluginId: DATABASE_PLUGIN_ID_V1, materializationId: 'database-materialization',
    } };
    const withdraw = publishCommittedAppShellPluginUiProjection(() => ({ ...EMPTY_PLUGIN_UI_PROJECTION,
      actionsById: { [`${DATABASE_PLUGIN_ID_V1}/${localId}`]: { ...PluginProjectedActionV2Schema.parse({
        title: metadata.title, dangerLevel: metadata.dangerLevel, readOnly: metadata.readOnly,
        placementBindings: metadata.placementBindings,
        id: localId, pluginId: DATABASE_PLUGIN_ID_V1, scopes: ['global', 'machine'], surfaces: ['ui'],
        execution: { target: 'daemon' }, occurrenceId: 'database-list', available: true,
      }), executionOrigin, hostOrigin: { serverId, machineId, interactionEnabled: true, phase: 'current',
        executionOrigin } } },
    }));
    const subject = { kind: 'database', serverId: serverIdentityId, target: {
      kind: 'environment', environmentId: environment.id, service: 'postgres',
    } } as const;
    const execute = vi.fn(() => ({ targets: [{ ...createDatabaseDescriptorV1Fixture(), label: 'App Database',
      automationSubject: { ok: true, subject } }], completeness: { complete: true } }));
    await answerExternalActionAccountForHome(homes, serverId, {
      actionId: 'action.invoke', tokenEpoch: 0, machineId, installationId: 'installation', execute,
    });
    const onChange = vi.fn();
    const screen = await renderScreen(<ActionSubjectSelect testID="subject"
      operand={{ kind: { kind: 'database' } }} subject={undefined} machineId="unrelated-machine" serverId={serverId}
      onChange={onChange} />);
    try {
      const menu = () => screen.findByType(DropdownMenu);
      expect(homes.requests.filter(request => request.path.split('?')[0] === path)).toHaveLength(0);
      await act(async () => menu().props.onOpenChange(true));
      await vi.waitFor(() => expect(menu().props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Production' }),
      ])));
      expect(execute).not.toHaveBeenCalled();
      const choose = (title: string) => {
        const row = menu().props.items.find(item => item.title === title);
        expect(row).toBeDefined();
        return act(async () => menu().props.onSelect(row!.id));
      };
      await choose('Production');
      await vi.waitFor(() => expect(homes.requests.map(request => request.path.split('?')[0]))
        .toContain('/v1/actions/action.invoke'));
      await vi.waitFor(() => expect(menu().props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'App Database' }),
      ])));
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith({
        action: { pluginId: DATABASE_PLUGIN_ID_V1, localId }, expectedContributorOccurrenceId: 'database-list',
        input: { scope: { kind: 'environment', environment: { serverId: serverIdentityId,
          projectSourceId: environment.projectSourceId, environmentId: environment.id } } },
      }, expect.objectContaining({ target: expect.objectContaining({ machineId }) }));
      await choose('App Database');
      expect(onChange).toHaveBeenCalledWith(subject);
    } finally {
      await screen.unmount();
      withdraw();
    }
  });

  it('reads the saved Environment name without opening the list', async () => {
    const serverId = await homes.addHome({
      name: 'Subject names',
      serverUrl: 'https://saved-subject-name.test',
      serverIdentityId: 'srv_saved_subject_name',
      accountId: 'account-owner',
      accountEncryptionMode: 'plain',
      active: true,
    });
    const detail = createDeploymentEnvironmentDetailV1({
      environment: createDeploymentEnvironmentHeaderV1({
        id: 'production',
        serverId: 'srv_saved_subject_name',
        contentArtifactId: 'subject-production',
      }),
    });
    const { captureLazyActionAccountContext } =
      await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
      await account.createArtifactDocument({
        artifactId: detail.environment.contentArtifactId,
        header: {
          kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
          title: 'Production',
        },
        body: JSON.stringify(detail.content),
      });
    } finally {
      account.dispose();
    }
    const root = '/v1/deployments/environments';
    homes.answer(serverId, root, {
      body: { ok: true, items: [detail.environment], nextCursor: null },
    });

    const screen = await renderScreen(
      <ActionSubjectSelect
        testID="subject"
        operand={{ kind: { kind: 'environment' } }}
        subject={{
          kind: 'environment',
          serverId: 'srv_saved_subject_name',
          environmentId: 'production',
        }}
        machineId={null}
        serverId={serverId}
        onChange={() => {}}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('Production'),
    );
    const environmentReads = homes.requests.filter((request) => request.path.startsWith(root));
    expect(environmentReads.map(({ path }) => path.split('?')[0])).toEqual([root]);
    const query = environmentReads[0]?.path.split('?')[1];
    expect(new URLSearchParams(query).getAll('environmentIds')).toEqual([detail.environment.id]);
    await screen.unmount();
  });
});

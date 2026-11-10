import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createSecretSettingsTestHarness,
  type SecretSettingsTestHarness,
} from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
installDisconnectedServerSocketBoundary();

const { DeploymentPermissionsPanel } =
  await import('./DeploymentPermissionsPanel');
const { createDefaultActionExecutor } =
  await import('@/sync/ops/actions/defaultActionExecutor');

const prefix = 'project-deployments.environment.permissions';
const environmentScope = (environmentId: string) => ({
  kind: 'environment',
  environmentId,
});
let account: SecretSettingsTestHarness;
beforeEach(async () => {
  account = await createSecretSettingsTestHarness({
    settings: settingsParse({
      // The policy Action itself is waived for both callers, so each write lands without a review.
      actionsSettingsV1: {
        v: 1,
        approvalWaivedSurfaces: { 'actions.policy.set': ['ui', 'agent'] },
      },
    }),
  });
});
afterEach(async () => {
  standardCleanup();
  await account.dispose();
});

function manager(overrides: Record<string, unknown> = {}) {
  const base = createDeploymentEnvironmentDetailV1();
  return {
    ...base,
    runtimeTargetLink: null,
    memberVersions: {},
    environment: {
      ...base.environment,
      capabilities: {
        ...base.environment.capabilities,
        role: 'manager' as const,
      },
      ...overrides,
    },
  };
}

function editing(
  updateEnvironment = vi.fn(async (..._args: unknown[]) => ({
    ok: true as const,
  })),
) {
  return {
    updateEnvironment,
    value: {
      actions: { setController: vi.fn(), updateEnvironment },
      serverId: account.scope.serverId,
      review: { pendingId: null, request: () => {}, open: () => {} },
      onChanged: () => {},
    },
  };
}

describe('Environment → Permissions: approvals', () => {
  it.each([
    { parent: 'required' as const, child: 'waived' as const },
    { parent: 'waived' as const, child: 'required' as const },
  ])('shows the canonical stricter preview approval ($parent parent, $child child)', async ({ parent, child }) => {
    const detail = manager({ id: 'preview-child', purpose: 'preview', previewTemplateEnvironmentId: 'template-parent',
      previewRepositoryId: 'repository', previewPullRequestId: '42', previewTargetLinkId: 'preview-runtime' });
    let actionsSettingsV1 = setScopedActionApprovalPreference({ settings: account.persistedSettings.actionsSettingsV1,
      actionId: 'deployments.deploy', scope: { kind: 'environment', environmentId: 'template-parent' },
      surface: 'agent', mode: parent });
    actionsSettingsV1 = setScopedActionApprovalPreference({ settings: actionsSettingsV1,
      actionId: 'deployments.deploy', scope: { kind: 'environment', environmentId: 'preview-child' },
      surface: 'agent', mode: child });
    await account.dispose();
    account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1 }) });
    const screen = await renderScreen(<DeploymentPermissionsPanel detail={detail as never}
      machineName={() => 'vps-1'} onOpenController={() => {}} editing={editing().value as never} />);
    try {
      const deploy = `${prefix}.approvals.deployments.deploy`;
      expect(screen.findByTestId(`${deploy}:mode:ask_first`)?.props.accessibilityState.checked).toBe(true);
      expect(screen.findByTestId(`${deploy}:mode:allowed`)?.props.accessibilityState.checked).toBe(false);
      expect(screen.findByTestId(`${deploy}.loosening`)).toBeNull();
    } finally { await screen.unmount(); }
  });

  it('writes one Environment-scoped approval from the row, and reads one an agent wrote through the same Action', async () => {
    const detail = manager();
    const screen = await renderScreen(
      <DeploymentPermissionsPanel
        detail={detail as never}
        machineName={() => 'vps-1'}
        onOpenController={() => {}}
        editing={editing().value as never}
      />,
    );
    const deploy = `${prefix}.approvals.deployments.deploy`;
    expect(
      screen.findByTestId(`${deploy}:mode:default`)?.props.accessibilityState
        .checked,
    ).toBe(true);

    // Person path: Allowed on Deploy writes exactly this Environment's agent waiver.
    await screen.pressByTestIdAsync(`${deploy}:mode:allowed`);
    await vi.waitFor(() =>
      expect(
        account.persistedSettings.actionsSettingsV1.scopedApprovalPreferences,
      ).toEqual([
        {
          actionId: 'deployments.deploy',
          scope: environmentScope(detail.environment.id),
          approvalRequiredSurfaces: [],
          approvalWaivedSurfaces: ['agent'],
        },
      ]),
    );
    expect(
      account.persistedSettings.actionsSettingsV1.actions['deployments.deploy'],
    ).toBeUndefined();

    // Agent path: the same Action, scoped to this Environment, shows on the Promote row.
    const result = await createDefaultActionExecutor().execute(
      'actions.policy.set',
      {
        actionId: 'deployments.promote',
        audience: 'agent',
        scope: environmentScope(detail.environment.id),
        mode: 'ask_first',
      },
      { surface: 'agent', serverId: account.scope.serverId },
    );
    expect(result).toMatchObject({ ok: true });
    await act(async () => {});
    await vi.waitFor(() =>
      expect(
        screen.findByTestId(
          `${prefix}.approvals.deployments.promote:mode:ask_first`,
        )?.props.accessibilityState.checked,
      ).toBe(true),
    );
    await screen.unmount();
  });

});

describe('Environment → Permissions: approvals read as what the person does (PAGE-ACCEPT-85 D10)', () => {
  it('titles each row by the operation, with a consequence line, not by the Action spec title', async () => {
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    const { ActionScopedApprovalRow } = await import('@/components/settings/actions/ActionScopedApprovalRow');
    const screen = await renderScreen(<DeploymentPermissionsPanel detail={manager() as never}
      machineName={() => 'vps-1'} onOpenController={() => {}} editing={null} />);
    const rows = screen.findAllByType(ActionScopedApprovalRow);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const actionId = String(row.props.testIDPrefix).replace(`${prefix}.approvals.`, '');
      expect(row.props.title).not.toBe(getActionSpec(actionId as never).title);
      expect(row.props.subtitle).toEqual(expect.any(String));
    }
    await screen.unmount();
  });
});

describe('Environment → Permissions: chosen people', () => {
  it('offers Chosen people only where there is a Team to choose from', async () => {
    const { SegmentedChoiceItem } =
      await import('@/components/ui/lists/SegmentedChoiceItem');
    const personal = await renderScreen(
      <DeploymentPermissionsPanel
        detail={manager() as never}
        machineName={() => 'vps-1'}
        onOpenController={() => {}}
        editing={editing().value as never}
      />,
    );
    const options = (screen: typeof personal) =>
      screen
        .findAllByType(SegmentedChoiceItem)
        .find((node) => node.props.testID === `${prefix}.deployers`)
        ?.props.options.map((option: { id: string }) => option.id);
    expect(options(personal)).toEqual(['managers', 'members']);
    await personal.unmount();
    const team = await renderScreen(
      <DeploymentPermissionsPanel
        detail={manager({ owner: { kind: 'team', teamId: 'team-a' } }) as never}
        machineName={() => 'vps-1'}
        onOpenController={() => {}}
        editing={editing().value as never}
      />,
    );
    expect(options(team)).toEqual(['managers', 'members', 'chosen']);
    await team.unmount();
  });

  it('removes one chosen person through deployments.environments.update with the remaining principals', async () => {
    const principals = [
      { principalKind: 'account', principalId: 'account-ana' },
      { principalKind: 'teamGroup', principalId: 'group-ops' },
    ];
    const detail = manager({
      owner: { kind: 'team', teamId: 'team-a' },
      deployerMode: 'chosen',
      deployerPrincipals: principals,
    });
    const { updateEnvironment, value } = editing();
    const screen = await renderScreen(
      <DeploymentPermissionsPanel
        detail={detail as never}
        machineName={() => 'vps-1'}
        onOpenController={() => {}}
        editing={value as never}
      />,
    );
    expect(
      screen.findByTestId(`${prefix}.chosen.teamGroup.group-ops`),
    ).not.toBeNull();
    await screen.pressByTestIdAsync(
      `${prefix}.chosen.account.account-ana.remove`,
    );
    expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith(
      detail.environment,
      { deployerMode: 'chosen', deployerPrincipals: [principals[1]] },
    );
    await screen.unmount();
  });

  it('opens an empty chosen list before saving, so the first pick saves the mode and the person at once', async () => {
    const { SegmentedChoiceItem } =
      await import('@/components/ui/lists/SegmentedChoiceItem');
    const detail = manager({ owner: { kind: 'team', teamId: 'team-a' } });
    const { updateEnvironment, value } = editing();
    const screen = await renderScreen(
      <DeploymentPermissionsPanel
        detail={detail as never}
        machineName={() => 'vps-1'}
        onOpenController={() => {}}
        editing={value as never}
      />,
    );
    const deployers = screen
      .findAllByType(SegmentedChoiceItem)
      .find((node) => node.props.testID === `${prefix}.deployers`);
    await act(async () => deployers!.props.onChange('chosen'));
    expect(updateEnvironment).not.toHaveBeenCalled();
    expect(screen.findByTestId(`${prefix}.chosen.empty`)).not.toBeNull();
    expect(screen.findByTestId(`${prefix}.chosen.add`)).not.toBeNull();
    await screen.unmount();
  });
});

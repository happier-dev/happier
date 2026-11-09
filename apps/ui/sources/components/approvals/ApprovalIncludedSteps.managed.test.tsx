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

installApprovalCommonModuleMocks({
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalIncludedSteps } = await import('./ApprovalIncludedSteps');
const { t } = await import('@/text');

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

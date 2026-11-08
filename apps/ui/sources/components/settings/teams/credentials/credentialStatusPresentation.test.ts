import { describe, expect, it } from 'vitest';

import { teamCredentialResourceFixture } from '@/dev/testkit';
import { t } from '@/text';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { teamCredentialStatusPresentation } from './credentialStatusPresentation';
import { resourceAdministrationSummaryLines } from './teamCredentialPresentation';

const NOT_CUSTODIAN = {
  updateBrokerPlacement: false,
  narrowDisclosure: false,
  refreshDirectMaterial: false,
} as const;

function recipientEntry(recoveryAction: 'select_broker' | 'retry') {
  return TeamCredentialResourceCatalogEntryV1Schema.parse({
    id: 'resource-1',
    teamId: 'team-1',
    displayName: 'Shared Claude',
    resourceRevision: 1,
    sourcePresentation: teamCredentialResourceFixture().sourcePresentation,
    readiness: { kind: 'broker_unavailable' },
    recoveryAction,
    mayBroker: true,
    mayReceiveDirect: false,
    directMaterialState: 'never_delivered',
    sessionUsePolicy: 'personal_allowed',
    providerModels: [],
    connectedServiceSelections: [],
  });
}

describe('teamCredentialStatusPresentation', () => {
  it('gives the broker choice only to the source owner and tells everyone else whom to ask', () => {
    const owner = teamCredentialStatusPresentation(
      teamCredentialResourceFixture({
        readiness: { kind: 'broker_unavailable' },
        recoveryAction: 'select_broker',
      }),
    );
    const manager = teamCredentialStatusPresentation(
      teamCredentialResourceFixture({
        readiness: { kind: 'broker_unavailable' },
        recoveryAction: 'select_broker',
        sourceOwnerDisplayName: 'Rina Okafor',
        capabilities: NOT_CUSTODIAN,
      }),
    );
    const member = teamCredentialStatusPresentation(
      recipientEntry('select_broker'),
    );

    // Providers round4 L4: one broker repair instruction, selected by the existing capability owner.
    expect(owner.cause).toBe(t('teams.credentials.recovery.brokerUnavailableOwner'));
    expect(manager.cause).toBe(t('teams.credentials.recovery.brokerUnavailableNamed', { name: 'Rina Okafor' }));
    expect(member.cause).toBe(t('teams.credentials.recovery.brokerUnavailableMember'));

    expect(owner.recovery?.destination).toBe('broker_selection');
    expect(owner.handoff).toBeNull();
    // The administration projection names the source owner; a recipient catalog row does not.
    expect(manager.recovery).toBeNull();
    expect(manager.handoff).toBeNull();
    expect(member.recovery).toBeNull();
    expect(member.handoff).toBeNull();
  });

  it('keeps a repair anyone can make as the viewer’s own action', () => {
    const member = teamCredentialStatusPresentation(recipientEntry('retry'));
    expect(member.recovery?.destination).toBe('retry');
    expect(member.handoff).toBeNull();
  });

  it('carries the same role rule into the Shared credentials list row', () => {
    const ownerLines = resourceAdministrationSummaryLines(
      teamCredentialResourceFixture({
        readiness: { kind: 'broker_unavailable' },
        recoveryAction: 'select_broker',
      }),
    );
    const memberLines = resourceAdministrationSummaryLines(
      recipientEntry('select_broker'),
    );
    expect(ownerLines).not.toContain(
      t('teams.credentials.recovery.ownerHandoff'),
    );
    expect(memberLines).toContain(t('teams.credentials.recovery.brokerUnavailableMember'));
  });
});

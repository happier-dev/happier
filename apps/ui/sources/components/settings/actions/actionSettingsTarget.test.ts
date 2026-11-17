import { describe, expect, it } from 'vitest';
import { applyApprovalProfileOverlayV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { readActionAudiencePolicy } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

import {
  buildApprovalProfileActionResetChange,
  resolveActionSettingsTargetWrite,
} from './actionSettingsTarget';

const careful = {
  id: 'artifact-careful',
  name: 'Careful agent',
  actions: { 'session.spawn_new': { disabledSurfaces: ['agent' as const] } },
};
const account = ActionsSettingsV1Schema.parse({
  v: 1,
  actions: {
    'session.stop': { disabledSurfaces: ['mcp'], approvalRequiredSurfaces: [] },
  },
});
const profileRow = {
  id: careful.id,
  profile: careful,
  access: 'owner' as const,
  revision: { headerVersion: 2, bodyVersion: 7 },
};
const profileRows = [profileRow];
const profileTarget = { kind: 'profile', id: careful.id } as const;

function updated(write: ReturnType<typeof resolveActionSettingsTargetWrite>) {
  if (
    !write ||
    !('profileChange' in write) ||
    write.profileChange.kind !== 'update'
  )
    throw new Error('expected an Artifact profile update');
  expect(write.profileChange.id).toBe(careful.id);
  expect(write.profileChange.expectedRevision).toEqual(profileRow.revision);
  expect(write.profileChange.profile).not.toHaveProperty('id');
  return { id: write.profileChange.id, ...write.profileChange.profile };
}

// APPROVED Plan03 U1: profile content is an Artifact; every edit carries its held revision.
// OWNER 2026-11-15: a profile page is the Approval settings screen writing into that profile. Each row reads the
// Account's answer until changed; a change copies the Account's row for that Action and changes one surface.
describe('Actions settings writer target', () => {
  it('sends Account intents unchanged', () => {
    const input = {
      actionId: 'session.stop',
      audience: 'agent',
      mode: 'ask_first',
    } as const;
    expect(
      resolveActionSettingsTargetWrite({
        target: { kind: 'account' },
        account,
        profileRows,
        input,
      }),
    ).toBe(input);
  });

  it('writes a profile row from the Account answer plus the one surface the person changed, keeping its other Actions', () => {
    const profile = updated(
      resolveActionSettingsTargetWrite({
        target: profileTarget,
        account,
        profileRows,
        input: {
          actionId: 'session.stop',
          audience: 'agent',
          mode: 'ask_first',
        },
      }),
    );
    expect(profile.actions?.['session.spawn_new']).toEqual(
      careful.actions['session.spawn_new'],
    );
    const merged = applyApprovalProfileOverlayV1(account, profile);
    expect(readActionAudiencePolicy(merged, 'session.stop', 'agent').mode).toBe(
      'ask_first',
    );
    // The Account's own choice for another surface of that Action carries into the profile's row.
    expect(readActionAudiencePolicy(merged, 'session.stop', 'mcp').mode).toBe(
      'off',
    );
    // The Account itself is untouched: the write is a Artifact update only.
    expect(
      readActionAudiencePolicy(account, 'session.stop', 'agent').mode,
    ).toBe('default');
  });

  it('turns a surface off and back on inside the profile', () => {
    const off = updated(
      resolveActionSettingsTargetWrite({
        target: profileTarget,
        account,
        profileRows,
        input: {
          actionId: 'session.stop',
          change: {
            kind: 'audience_enabled',
            audience: 'agent',
            enabled: false,
          },
        },
      }),
    );
    expect(
      readActionAudiencePolicy(
        applyApprovalProfileOverlayV1(account, off),
        'session.stop',
        'agent',
      ).mode,
    ).toBe('off');
    const nextRows = [{ ...profileRow, profile: off }];
    const on = updated(
      resolveActionSettingsTargetWrite({
        target: profileTarget,
        account,
        profileRows: nextRows,
        input: {
          actionId: 'session.stop',
          change: {
            kind: 'audience_enabled',
            audience: 'agent',
            enabled: true,
          },
        },
      }),
    );
    expect(
      readActionAudiencePolicy(
        applyApprovalProfileOverlayV1(account, on),
        'session.stop',
        'agent',
      ).mode,
    ).toBe('default');
  });

  it('refuses what a profile does not carry, and an unknown profile', () => {
    const refused = [
      { actionId: 'session.stop', change: { kind: 'enabled', enabled: false } },
      {
        actionId: 'session.stop',
        change: {
          kind: 'placement',
          placement: 'command_palette',
          enabled: false,
        },
      },
      {
        actionId: 'session.stop',
        change: { kind: 'tool_exposure', surface: 'agent', mode: 'default' },
      },
      {
        actionId: 'session.stop',
        audience: 'agent',
        scope: { kind: 'machine', machineId: 'm1' },
        mode: 'ask_first',
      },
    ] as const;
    for (const input of refused) {
      expect(
        resolveActionSettingsTargetWrite({
          target: profileTarget,
          account,
          profileRows,
          input: input as never,
        }),
      ).toBeNull();
    }
    expect(
      resolveActionSettingsTargetWrite({
        target: { kind: 'profile', id: 'artifact-gone' },
        account,
        profileRows,
        input: {
          actionId: 'session.stop',
          audience: 'agent',
          mode: 'ask_first',
        },
      }),
    ).toBeNull();
  });

  it('"Use Account setting" removes only that Action from the profile', () => {
    const write = buildApprovalProfileActionResetChange(
      profileRow,
      'session.spawn_new',
    );
    expect(updated(write)).toEqual({ id: careful.id, name: careful.name });
  });
});

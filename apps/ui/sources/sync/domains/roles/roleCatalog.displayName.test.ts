import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
  buildRoleCatalog,
  findRoleDisplayName,
  parseRolesListOutput,
  resolveRoleDisplayName,
} from './roleCatalog';

const accountRoleId = 'ebc13380-d940-41e8-a6c4-403145c4b056';
const [accountEntry] = buildRoleCatalog({
  overrides: {},
  items:
    parseRolesListOutput({
      items: [
        {
          roleId: accountRoleId,
          role: {
            name: 'Security reviewer',
            instructions: 'Review for security issues.',
            runsAs: { kind: 'session' },
            workspaceWrites: 'deny',
            secondOpinion: 'off',
            enabled: true,
          },
          revision: { headerVersion: 1, bodyVersion: 1 },
          shared: false,
          viewOnly: false,
          migratedFromV0_2: false,
        },
      ],
    }) ?? [],
});

describe('a role as people read it', () => {
  it('names an Account Role from its catalog entry and never shows its id', () => {
    if (!accountEntry)
      throw new Error('Expected the Account Role catalog entry');
    expect(
      resolveRoleDisplayName(accountRoleId, [], {
        entry: accountEntry,
        status: 'ready',
      }),
    ).toBe('Security reviewer');
    // Built-in and workflow roles name themselves without the catalog.
    expect(findRoleDisplayName('reviewer')).toBe(
      findRoleDisplayName('reviewer', [], accountEntry),
    );
    expect(findRoleDisplayName(accountRoleId)).toBeNull();
  });

  it('says the catalog is reading, or that the role is gone, instead of the id', () => {
    expect(
      resolveRoleDisplayName(accountRoleId, [], {
        entry: null,
        status: 'loading',
      }),
    ).toBe(t('common.loading'));
    expect(
      resolveRoleDisplayName(accountRoleId, [], {
        entry: null,
        status: 'ready',
      }),
    ).toBe(t('roles.rail.unavailableRole'));
    expect(
      resolveRoleDisplayName(accountRoleId, [], {
        entry: null,
        status: 'failed',
      }),
    ).toBe(t('common.unavailable'));
  });
});

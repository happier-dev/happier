import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';
import type { SharePrincipalPresentation } from '../shareSheetTypes';
import {
  createTaskShareAdapter,
  readTaskShareDisclosure,
} from './taskShareAdapter';

const base = {
  encrypted: false,
  readiness: new Map(),
  loading: false,
  readOnly: false,
  retryContent: () => {},
};
const person = (accountId: string): SharePrincipalPresentation => ({
  ref: { kind: 'account', accountId },
  key: `account:${accountId}`,
  displayName: accountId,
  accessibilityLabel: accountId,
});
const team: SharePrincipalPresentation = {
  ref: { kind: 'team', teamId: 'core' },
  key: 'team:core',
  displayName: 'Core',
  accessibilityLabel: 'Core',
};

describe('createTaskShareAdapter', () => {
  it('lists everything the whole task discloses before the roster: notes, links, linked Session titles and blocked-by refs', () => {
    const disclosure = readTaskShareDisclosure({
      title: 'Fix login redirect',
      notes: 'Repro on Safari only.\nSee the trace.',
      links: [
        { url: 'https://github.com/acme/app/pull/42', title: 'PR #42' },
        { url: 'https://docs.acme.dev/auth' },
      ],
      linkedSessions: {
        a: { title: 'Debug Safari redirect', linkedAt: 2 },
        b: { title: 'Review auth PR', linkedAt: 1 },
      },
      blockedBy: ['task-1', 'task-2'],
    });
    const adapter = createTaskShareAdapter({ ...base, disclosure });
    const leading =
      adapter.sections?.({ idPrefix: '', editable: true, onExpand: () => {} })
        .leading ?? [];
    expect(leading).toHaveLength(1);
    const section = leading[0]!;
    if (section.kind !== 'static')
      throw new Error('Expected the disclosure section');
    expect(section.title).toBe(t('shareSheet.tasks.disclosure.title'));
    const rows = Object.fromEntries(
      section.options.map((option) => [option.label, option.subtitle]),
    );
    expect(rows[t('shareSheet.tasks.disclosure.notes')]).toBe(
      'Repro on Safari only.',
    );
    expect(rows[t('shareSheet.tasks.disclosure.links')]).toBe(
      'PR #42 · docs.acme.dev/auth',
    );
    // Newest linked work first: the Session titles travel with the task even though the Sessions don't.
    expect(rows[t('shareSheet.tasks.disclosure.linkedSessions')]).toBe(
      'Debug Safari redirect · Review auth PR',
    );
    expect(rows[t('shareSheet.tasks.disclosure.blockedBy')]).toBe(
      t('shareSheet.tasks.disclosure.tasks', { count: 2 }),
    );
    // The linked resources keep their own access, said once in the rules.
    expect(adapter.notes).toEqual([t('shareSheet.tasks.notes.linkedAccess')]);
  });

  it('omits empty disclosure rows and offers only view and edit', () => {
    const adapter = createTaskShareAdapter({
      ...base,
      disclosure: readTaskShareDisclosure({ title: 'Plain task' }),
    });
    expect(
      adapter.sections?.({ idPrefix: '', editable: true, onExpand: () => {} })
        .leading,
    ).toBeUndefined();
    expect(Object.keys(adapter.levels)).toEqual(['view', 'edit']);
  });

  it('shows ready, pending and every unavailable reason from one mixed collective summary without guessing missing or empty readiness', () => {
    const empty = { readyCount: 0, pendingCount: 0, unavailableCounts: {
      plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0,
    } };
    const adapter = createTaskShareAdapter({ ...base, encrypted: true, disclosure: null,
      readiness: new Map([
        ['team:core', { readyCount: 2, pendingCount: 3, unavailableCounts: {
          plain_account: 1, encryption_setup_required: 1, encryption_inconsistent: 1,
        } }],
        ['account:ready', { ...empty, readyCount: 1 }], ['account:empty', empty],
      ]),
    });
    expect(adapter.principalTags?.(team)).toEqual([
      t('status.ready'), t('shareSheet.tasks.readiness.membersKeysPending', { count: 3 }),
      t('shareSheet.tasks.readiness.homeManaged'), t('shareSheet.tasks.readiness.setupRequired'),
      t('shareSheet.tasks.readiness.repairRequired'),
    ]);
    expect(adapter.principalTags?.(person('ready'))).toEqual([t('status.ready')]);
    expect(adapter.principalTags?.(person('empty'))).toEqual([]);
    expect(adapter.principalTags?.(person('unknown'))).toEqual([]);
  });

  it('explains why a keyless recipient of an encrypted task cannot open it, and names pending Team keys', () => {
    const sendKeys = vi.fn();
    const adapter = createTaskShareAdapter({
      ...base,
      encrypted: true,
      disclosure: null,
      sendKeys,
      readiness: new Map([
        ['account:plain', { readyCount: 0, pendingCount: 0, unavailableCounts: { plain_account: 1, encryption_setup_required: 0, encryption_inconsistent: 0 } }],
        [
          'account:fresh',
          { readyCount: 0, pendingCount: 0, unavailableCounts: { plain_account: 0, encryption_setup_required: 1, encryption_inconsistent: 0 } },
        ],
        ['team:core', { readyCount: 0, pendingCount: 3, unavailableCounts: { plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0 } }],
      ] as const),
    });
    expect(adapter.notes).toContain(t('shareSheet.tasks.notes.encrypted'));
    expect(adapter.principalTags?.(person('plain'))).toEqual([
      t('shareSheet.tasks.readiness.homeManaged'),
    ]);
    expect(adapter.principalTags?.(person('fresh'))).toEqual([
      t('shareSheet.tasks.readiness.setupRequired'),
    ]);
    expect(adapter.principalTags?.(team)).toEqual([
      t('shareSheet.tasks.readiness.membersKeysPending', { count: 3 }),
    ]);
    expect(adapter.principalTags?.(person('ready'))).toEqual([]);
  });
});

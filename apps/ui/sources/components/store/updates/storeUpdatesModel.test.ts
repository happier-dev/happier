import { describe, expect, it } from 'vitest';
import {
  SkillListItemV1Schema,
  type SkillListItemV1,
} from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { RegistryUpdateCheckResultV1 } from '@happier-dev/protocol/registries';

import type { InstalledRow, InstalledSkillRow } from '../catalog/storeKinds';
import { buildStoreUpdates, captureStoreUpdateBasis, describeUncheckedSources } from './storeUpdatesModel';

const scope = { serverId: 'server-a', accountId: 'account-a' };
const registry = (id: string, commit: string) => ({
  kind: 'registry' as const,
  registry: {
    sourceId: 'registry:skills',
    format: 'git' as const,
    sourceUrl: 'https://git.example.test/team/skills.git',
    itemId: id,
    importedAt: 1,
    ref: {
      kind: 'gitTree' as const,
      repo: 'https://git.example.test/team/skills.git',
      path: id,
      commit: commit.repeat(40),
      treeSha: 'b'.repeat(40),
    },
  },
});
function skill(
  id: string,
  extra: Partial<SkillListItemV1> = {},
): InstalledSkillRow {
  const native = SkillListItemV1Schema.parse({
    skillId: id,
    name: id,
    description: null,
    revision: '1:1',
    rules: [],
    trust: 'text_only',
    cost: { descriptionTokens: 0, bodyTokens: 0 },
    provenance: registry(id, 'a'),
    modified: false,
    updatePolicy: 'manual',
    createdAt: 1,
    migratedFromContext: false,
    userInvocable: true,
    folderId: null,
    ...extra,
  });
  return { kind: 'skill', key: `skill:${id}`, scope, native, reach: [] };
}

describe('buildStoreUpdates', () => {
  it('keeps browser extension updates profile-qualified and supersedes an applied version without losing another profile', () => {
    const extensionId = 'a'.repeat(32);
    const browserRow = (profileId: string, version: string, current = false, catalog = true, machineId = 'machine-a', unpacked = false): InstalledRow => ({
      kind: 'browserExtension', subject: 'extension', key: `browser:${machineId}:${profileId}:${extensionId}`, scope, machineId,
      native: { profileId, restartRequired: false, extension: { id: extensionId, name: 'Passwords', version,
        enabled: true, source: unpacked ? { kind: 'unpacked', directory: '/extensions/passwords' } : { kind: 'webStore', extensionId }, directory: '/extensions/passwords',
        permissions: ['storage'], hostPermissions: [], ...(catalog ? { provenance: { sourceId: 'registry:extensions',
          sourceUrl: 'https://catalog.example/extensions.json', format: 'happier-catalog', itemId: 'passwords',
          importedAt: 1, ref: { kind: 'content', digest: `sha256:${'b'.repeat(64)}` } } } : {}),
        ...(current ? { upstream: { state: 'current' } } : {}) } },
    });
    const first = browserRow('work', '1.0');
    const second = browserRow('personal', '1.0', false, false);
    const otherMachine = browserRow('work', '2.0', true, false, 'machine-b', true);
    const results: RegistryUpdateCheckResultV1['results'] = ['work', 'personal'].map(profileId => ({
      kind: 'browserExtension', key: JSON.stringify([profileId, extensionId]), machineId: 'machine-a',
      upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } },
    }));
    const allResults = [...results, { kind: 'browserExtension' as const, key: JSON.stringify(['work', extensionId]),
      machineId: 'machine-b', upstream: { state: 'current' as const } }];
    const check = { checkedAt: 20, failed: false, basis: captureStoreUpdateBasis([first, second, otherMachine]) };
    const waiting = buildStoreUpdates([first, second, otherMachine], allResults, check);
    expect({ count: waiting.count, tracked: waiting.tracked }).toEqual({ count: 2, tracked: 3 });
    expect(waiting.sections).toMatchObject([{ kind: 'browserExtension', entries: [
      { key: first.key, from: '1.0', to: '2.0', state: 'available' },
      { key: second.key, from: '1.0', to: '2.0', state: 'available' },
    ] }]);
    expect(waiting.sections[0]?.entries[0]?.apply).toEqual({ actionId: 'browser.extensions.update',
      input: { machineId: 'machine-a', profileId: 'work', extensionId, expectedVersion: '2.0' } });
    const after = buildStoreUpdates([browserRow('work', '2.0', true), second, otherMachine], allResults, check);
    expect(after.count).toBe(1);
    expect(after.sections[0]?.entries.map(entry => entry.key)).toEqual([second.key]);
  });
  it('reports only successfully checked current subjects, with no freshness claim before a check', () => {
    const rows = [skill('current'), skill('gone'), skill('failed')];
    expect(buildStoreUpdates(rows, []).freshness).toEqual({ checked: 0, tracked: 3, checkedAt: null });
    const results: RegistryUpdateCheckResultV1['results'] = [
      { kind: 'skill', key: 'current', upstream: { state: 'current' } },
      { kind: 'skill', key: 'gone', upstream: { state: 'removed_from_source' } },
      { kind: 'skill', key: 'failed', upstream: { state: 'unchecked', reason: { state: 'unreachable' } } },
      { kind: 'skill', key: 'not-held', upstream: { state: 'current' } },
    ];
    const check = { checkedAt: 42, failed: true };
    const partial = buildStoreUpdates(rows, results, check);
    expect(partial.freshness).toEqual({ checked: 2, tracked: 3, checkedAt: 42 });
    expect(partial.sections.flatMap(section => section.entries).find(entry => entry.state === 'removed')?.status)
      .toEqual({ kind: 'removed' });
    const basis = new Map(rows.map(row => [row.key, JSON.stringify([row.native.provenance, row.native.revision])]));
    const advanced = { ...rows[0]!, native: { ...rows[0]!.native, revision: '2:2' } };
    expect(buildStoreUpdates([advanced, ...rows.slice(1)], results, { ...check, basis }).freshness.checked).toBe(1);
  });
  it('lets newer native provenance and revisions supersede a finite check without disturbing unchanged items', () => {
    const before = skill('applied', { upstream: { state: 'update_available' } });
    const other = skill('other');
    const latest = registry('applied', 'c').registry.ref;
    const results: RegistryUpdateCheckResultV1['results'] = [
      { kind: 'skill', key: 'applied', upstream: { state: 'update_available', latest } },
      { kind: 'skill', key: 'other', upstream: { state: 'update_available' } },
    ];
    const check = { checkedAt: 20, failed: false, basis: new Map([before, other].map(row =>
      [row.key, JSON.stringify([row.native.provenance, row.native.revision])])) };
    expect(buildStoreUpdates([before, other], results, check).count).toBe(2);
    const applied = skill('applied', { revision: '2:2', provenance: registry('applied', 'c'), upstream: { state: 'current' } });
    const view = buildStoreUpdates([applied, other], results, check);
    expect(view.sections.flatMap(section => section.entries).map(entry => entry.key)).toEqual(['skill:other']);
    expect(view.count).toBe(1);

    // A newer observation can also find another update without changing the
    // installed version. The older finite "current" cannot erase that fact.
    const newer = skill('applied', { revision: '1:2', upstream: { state: 'update_available', latest } });
    expect(buildStoreUpdates([newer], [{ kind: 'skill', key: 'applied', upstream: { state: 'current' } }], check)
      .sections[0]?.entries[0]?.state).toBe('available');
  });

  it.each(['mcpServer', 'agent'] as const)('follows newer %s native observations after a finite check', kind => {
    const row = (version: string, updatedAt: number, upstream: { state: 'current' | 'update_available' }): InstalledRow => {
      const origin = { kind: 'registry', provenance: { ...registry('docs', 'a').registry,
        ref: { kind: 'version', version } }, upstream };
      return kind === 'mcpServer'
        ? { kind, key: `${kind}:docs`, scope, reach: [], native: McpServerCatalogEntryV1Schema.parse({
          id: 'docs', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, origin, createdAt: 1, updatedAt,
        }) }
        : { kind, subject: 'definition', key: `${kind}:docs`, scope, native: AcpCatalogRecordV1Schema.parse({ v: 1,
          definitions: [{ id: 'docs', name: 'docs', title: 'Docs', launch: { kind: 'command', command: 'docs', args: [] },
            origin, createdAt: 1, updatedAt }],
        }).definitions[0]! };
    };
    const before = row('1', 1, { state: 'current' });
    if (before.kind !== 'mcpServer' && (before.kind !== 'agent' || before.subject !== 'definition')) throw new Error('Expected native definition');
    const origin = before.native.origin!;
    if (origin.kind !== 'registry') throw new Error('Expected registry origin');
    const check = { checkedAt: 20, failed: false,
      basis: new Map([[before.key, JSON.stringify([origin.provenance, before.native.updatedAt, origin.upstream])]]) };
    const update = [{ kind, key: 'docs', upstream: { state: 'update_available' as const, latest: { kind: 'version' as const, version: '2' } } }];
    expect(buildStoreUpdates([before], update, check).count).toBe(1);
    expect(buildStoreUpdates([row('2', 2, { state: 'current' })], update, check).count).toBe(0);
    expect(buildStoreUpdates([row('1', 2, { state: 'update_available' })],
      [{ kind, key: 'docs', upstream: { state: 'current' } }], check).sections[0]?.entries[0]?.state).toBe('available');
  });

  it('counts the same review entries only after a complete real check, keeping incomplete and unchecked counts unknown', () => {
    const origin = { kind: 'registry', provenance: registry('ready', 'a').registry };
    const rows: readonly InstalledRow[] = [
      { kind: 'mcpServer', key: 'mcp:ready', scope, reach: [], native: McpServerCatalogEntryV1Schema.parse({
        id: 'ready', name: 'ready', transport: 'stdio', stdio: { command: 'mcp', args: [] }, env: {}, origin, createdAt: 1, updatedAt: 1,
      }) },
      skill('mine', { modified: true }), skill('gone'), skill('current'),
      { kind: 'agent', subject: 'definition', key: 'agent:ready', scope, native: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: [{ id: 'ready', name: 'ready', title: 'Ready', launch: { kind: 'command', command: 'agent', args: [] },
          origin, createdAt: 1, updatedAt: 1 }],
      }).definitions[0]! },
    ];
    const results: RegistryUpdateCheckResultV1['results'] = [
      { kind: 'mcpServer', key: 'ready', upstream: { state: 'update_available' } },
      { kind: 'skill', key: 'mine', upstream: { state: 'update_available' } },
      { kind: 'skill', key: 'gone', upstream: { state: 'removed_from_source' } },
      { kind: 'skill', key: 'current', upstream: { state: 'current' } },
      { kind: 'agent', key: 'ready', upstream: { state: 'update_available' } },
    ];
    expect(buildStoreUpdates(rows, []).count).toBeNull();
    expect(buildStoreUpdates([], []).count).toBeNull();
    const complete = { checkedAt: 20, failed: false };
    const view = buildStoreUpdates(rows, results, complete);
    expect(view.count).toBe(4);
    expect(view.sections.map(section => section.kind)).toEqual(['mcpServer', 'skill', 'agent']);
    expect(view.count).toBe(view.sections.flatMap(section => section.entries).length);
    expect(buildStoreUpdates([], [], complete).count).toBe(0);
    expect(buildStoreUpdates(rows, results.slice(1), complete).count).toBeNull();
    expect(buildStoreUpdates(rows, results, { ...complete, failed: true }).count).toBeNull();
    expect(buildStoreUpdates(rows, [{ kind: 'skill', key: 'ready', upstream: {
      state: 'unchecked', reason: { state: 'unreachable' },
    } }], complete).count).toBeNull();
  });

  it('never turns a failed check into current: a recorded update stays, otherwise the item is unchecked', () => {
    const waiting = skill('waiting', {
      upstream: { state: 'update_available' },
    });
    const quiet = skill('quiet', { upstream: { state: 'current' } });
    const view = buildStoreUpdates(
      [waiting, quiet],
      [
        {
          kind: 'skill',
          key: 'waiting',
          upstream: { state: 'unchecked', reason: { state: 'unreachable' } },
        },
        {
          kind: 'skill',
          key: 'quiet',
          upstream: { state: 'unchecked', reason: { state: 'unreachable' } },
        },
      ],
    );
    expect(view.unchecked).toBe(2);
    expect(view.sections).toEqual([
      {
        kind: 'skill',
        entries: [
          expect.objectContaining({ key: 'skill:waiting', state: 'available' }),
          expect.objectContaining({
            key: 'skill:quiet',
            state: 'unchecked',
            reason: { state: 'unreachable' },
          }),
        ],
      },
    ]);
  });

  it('takes the latest completed check over the recorded state and asks for a choice when the person changed it', () => {
    const latest = {
      kind: 'gitTree' as const,
      repo: 'https://git.example.test/team/skills.git',
      path: 'mine',
      commit: 'c'.repeat(40),
      treeSha: 'd'.repeat(40),
    };
    const view = buildStoreUpdates(
      [
        skill('mine', { modified: true }),
        skill('stale', { upstream: { state: 'update_available' } }),
        skill('gone'),
        skill('written', { provenance: { kind: 'written' } }),
      ],
      [
        {
          kind: 'skill',
          key: 'mine',
          upstream: { state: 'update_available', latest },
        },
        { kind: 'skill', key: 'stale', upstream: { state: 'current' } },
        {
          kind: 'skill',
          key: 'gone',
          upstream: { state: 'removed_from_source' },
        },
      ],
    );
    expect(view.tracked).toBe(3);
    expect(
      view.sections[0]?.entries.map((entry) => [
        entry.key,
        entry.state,
        entry.from,
        entry.to,
      ]),
    ).toEqual([
      ['skill:mine', 'needsChoice', 'aaaaaaa', 'ccccccc'],
      ['skill:gone', 'removed', 'aaaaaaa', null],
    ]);
  });
});

describe('describeUncheckedSources', () => {
  it('names a labelled failing source once, leaves an unlabeled one unnamed, and never invents a name', () => {
    const failed = { state: 'unchecked' as const, reason: { state: 'unreachable' as const } };
    const results: RegistryUpdateCheckResultV1['results'] = [
      { kind: 'skill', key: 'a', upstream: failed, sourceId: 'registry:skills', sourceTitle: 'skills.sh' },
      { kind: 'skill', key: 'b', upstream: failed, sourceId: 'registry:skills', sourceTitle: 'skills.sh' },
      { kind: 'mcpServer', key: 'c', upstream: failed, sourceId: 'registry:custom' },
      { kind: 'agent', key: 'd', upstream: failed },
    ];
    const lines = describeUncheckedSources(results);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^skills\.sh · \S/);
    expect(lines[1]).toMatch(/^registry:custom · \S/);
    expect(lines[2]).not.toContain(' · ');
  });
});

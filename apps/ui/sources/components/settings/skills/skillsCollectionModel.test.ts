import { describe, expect, it } from 'vitest';
import { createSkillSourceNameResolver } from './skillSource';
import {
  SkillListItemV1Schema,
  type SkillListItemV1,
} from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

import {
  buildSkillsReach,
  skillReachesMachine,
  foldReachMachines,
  groupSkillsByFolder,
  groupSkillsByUse,
  resolveSkillsFirstVisit,
  resolveSkillsPresent,
  skillSource,
  skillsReachLegendCount,
} from './skillsCollectionModel';
import { buildSkillsNeedsALook } from './status/skillStatus';
import { arrivedReachDots } from './skillsReachTravel';

// Fixtures go through the canonical strict schema `skills.list` outputs, so a shape drift fails here.
function skill(
  id: string,
  overrides: Partial<SkillListItemV1> = {},
): SkillListItemV1 {
  return SkillListItemV1Schema.parse({
    skillId: id,
    name: id,
    description: `${id} description`,
    revision: '1:1',
    rules: [
      {
        id: `${id}-on`,
        skillId: id,
        target: { t: 'allMachines' },
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    trust: 'text_only',
    cost: { descriptionTokens: 10, bodyTokens: 300 },
    provenance: { kind: 'written' },
    modified: false,
    updatePolicy: 'manual',
    createdAt: 1,
    migratedFromContext: false,
    userInvocable: true,
    folderId: null,
    ...overrides,
  });
}

const machine = (
  id: string,
  agentIds: readonly string[],
  offline = false,
): ReachMachine => ({
  machineId: id,
  platform: 'posix',
  agentIds,
  name: id,
  online: !offline,
  offline,
  lastSeenAt: offline ? 1 : null,
});

describe('Skills collection model', () => {
  it('keeps an unobserved machine out of live reach and offline catch-up counts while retaining its rules', () => {
    const unknown = { ...machine('unknown', ['codex']), online: null };
    const reach = buildSkillsReach([skill('every')], [unknown]);
    expect(reach.machines[0]?.skillIds).toEqual(['every']);
    expect(reach.reachingCount).toBe(0);
    expect(reach.onlineReachedMachineCount).toBe(0);
    expect(reach.agentIds).toEqual([]);
    expect(reach.offlineMachineIds).toEqual([]);
    expect(reach.bodies).toEqual([{ key: 'unknown', online: false, dots: [{ key: 'every', tone: 'quiet' }] }]);
  });
  it('joins installed Agents with each Machine declaration: none does not reach, index does', () => {
    const agentsById = PluginProjectionV2Schema.shape.agentsById.parse({
      review: { id: 'review', identity: { pluginId: 'acme.skills', localId: 'review' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
      indexed: { id: 'indexed', identity: { pluginId: 'acme.skills', localId: 'indexed' },
        capabilities: { tools: { delivery: 'shell_bridge' } } },
    });
    const reached = { ...machine('reached', ['review', 'indexed']), agentDeclarationsById: agentsById };
    const reviewOnly = { ...machine('review-only', ['review']), agentDeclarationsById: agentsById };
    const differentDeclaration = { ...machine('different', ['indexed']), agentDeclarationsById: {
      indexed: { ...agentsById.review!, id: 'indexed', identity: agentsById.indexed!.identity },
    } };
    const reach = buildSkillsReach([skill('every')], [reached, reviewOnly, differentDeclaration]);
    expect(reach.agentIds).toEqual(['indexed']);
    expect(reach.onlineReachedMachineCount).toBe(1);
    expect(reach.machines.find(row => row.machine.machineId === 'review-only')?.skillIds).toEqual([]);
    expect(reach.machines.find(row => row.machine.machineId === 'different')?.skillIds).toEqual([]);
    expect(skillReachesMachine(skill('every'), reviewOnly)).toBe(false);
  });
  it('the present sentence: a plan-none-only roster reads as unsupported delivery, never as waiting for inventory', () => {
    const agentsById = PluginProjectionV2Schema.shape.agentsById.parse({
      review: { id: 'review', identity: { pluginId: 'acme.skills', localId: 'review' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
      indexed: { id: 'indexed', identity: { pluginId: 'acme.skills', localId: 'indexed' },
        capabilities: { tools: { delivery: 'shell_bridge' } } },
    });
    const items = [skill('a'), skill('b'), skill('off', { rules: [] })];
    const present = (machines: readonly ReachMachine[]) =>
      resolveSkillsPresent({ items, reach: buildSkillsReach(items, machines), needs: 0, firstVisit: null });

    const reviewOnly = { ...machine('review-only', ['review']), agentDeclarationsById: agentsById };
    expect(present([reviewOnly])).toEqual({ kind: 'unsupported', on: 2, agentIds: ['review'] });
    // No online machine has said which Agents it has: that is the inventory wait.
    expect(present([machine('quiet', [])])).toEqual({ kind: 'waiting', on: 2 });
    expect(present([machine('away', ['review'], true)])).toEqual({ kind: 'waiting', on: 2 });
    expect(present([])).toEqual({ kind: 'noMachines' });
    expect(resolveSkillsPresent({ items: [], reach: buildSkillsReach([], [reviewOnly]), needs: 0, firstVisit: null }))
      .toEqual({ kind: 'new' });

    // Mixed: the reach words name only Agents that take skills; the none Agent gets one note, and the
    // legend's Agents for that machine leave it out.
    const both = { ...machine('both', ['review', 'indexed']), agentDeclarationsById: agentsById };
    const mixed = present([both, { ...machine('away', ['indexed'], true), agentDeclarationsById: agentsById }]);
    expect(mixed).toMatchObject({ kind: 'reach', count: 2, agentIds: ['indexed'], machines: 1,
      unsupportedAgentIds: ['review'], catchUp: ['away'] });
    expect(buildSkillsReach(items, [both]).machines[0]?.supportedAgentIds).toEqual(['indexed']);
    // An Agent that takes skills on any online machine is never called unsupported.
    const elsewhere = { ...machine('elsewhere', ['review']), agentDeclarationsById: {
      review: { ...agentsById.indexed!, id: 'review', identity: agentsById.review!.identity },
    } };
    expect(present([reviewOnly, elsewhere])).toMatchObject({ kind: 'reach', unsupportedAgentIds: [] });
  });

  it('travel: the first drawn map is the baseline; later only newly reaching dots travel', () => {
    const bodies = (...keys: string[][]) => keys.map((dots) => ({ dots: dots.map((key) => ({ key })) }));
    const first = arrivedReachDots(null, bodies(['a', 'b'], ['a']));
    expect(first.arrived).toEqual([]);
    const next = arrivedReachDots(first.seen, bodies(['a', 'b', 'c'], ['a']));
    expect(next.arrived).toEqual(['c']);
    expect(arrivedReachDots(next.seen, bodies(['a'], [])).arrived).toEqual([]);
  });

  it('groups by folder through the library rule when a skill is filed; none filed keeps In use / Off', () => {
    const folders = { v: 1 as const, folders: [
      { id: 'w', name: 'Writing', parentId: null },
      { id: 'c', name: 'Client work', parentId: null },
    ] };
    const items = [skill('a'), skill('b', { folderId: 'w' }), skill('off', { rules: [], folderId: 'c' }),
      skill('lost', { folderId: 'gone' }), skill('d', { folderId: 'c' })];
    expect(groupSkillsByFolder(items, folders)?.map((group) => [group.title, group.rows.map((row) => row.skillId)]))
      .toEqual([['Client work', ['off', 'd']], ['Writing', ['b']], [null, ['a', 'lost']]]);
    expect(groupSkillsByFolder([skill('a'), skill('lost', { folderId: 'gone' })], folders)).toBeNull();
    // Names not read yet: the filed rows share ONE unnamed section, never one "Unavailable" header per folder.
    const unread = groupSkillsByFolder(items, null);
    expect(unread?.map((group) => [group.title, group.rows.map((row) => row.skillId)]))
      .toEqual([['Unavailable', ['b', 'off', 'lost', 'd']], [null, ['a']]]);
    expect(new Set(unread?.map((group) => group.id)).size).toBe(unread?.length);
    expect(groupSkillsByFolder(items, { v: 1, folders: [] })).toBeNull();
  });

  it('keeps named sections in id order through recovery, independently of row cohort or title order', () => {
    const folders = { v: 1 as const, folders: [
      { id: 'a', name: 'Writing', parentId: null }, { id: 'z', name: 'Client work', parentId: null },
    ] };
    const items = [skill('z-first', { folderId: 'z' }), skill('a-second', { folderId: 'a' }), skill('unfiled')];
    const order = (names: typeof folders | null) => groupSkillsByFolder(items, names)?.map(group => group.id);
    expect(order(folders)).toEqual(['a', 'z', null]);
    // Unread names hold every filed row in one unnamed section (above the unfiled rows), then each named folder returns.
    expect(order(null)?.length).toBe(2);
    expect(order(null)?.at(-1)).toBeNull();
    expect(order(folders)).toEqual(['a', 'z', null]);
  });

  it('groups In use / Off by rules: no rule turning it on is Off (D4)', () => {
    const groups = groupSkillsByUse([
      skill('a'),
      skill('b', { rules: [] }),
      skill('c'),
    ]);
    expect(groups.inUse.map((item) => item.skillId)).toEqual(['a', 'c']);
    expect(groups.off.map((item) => item.skillId)).toEqual(['b']);
  });

  it('a skill reaches a machine only through an Agent that takes it there', () => {
    const nl2 = machine('nl2', ['codex']);
    const onlyMbp = skill('only-mbp', {
      rules: [
        {
          id: 'x',
          skillId: 'only-mbp',
          target: { t: 'machine', machineId: 'mbp' },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    expect([skill('every'), onlyMbp].filter((item) => skillReachesMachine(item, nl2)).map((item) => item.skillId))
      .toEqual(['every']);
  });

  it('counts updates and source choices as needing a look, never Off or local modification alone', () => {
    const update = skill('u', { upstream: { state: 'update_available' } });
    expect(
      buildSkillsNeedsALook([
        update,
        skill('removed', { upstream: { state: 'removed_from_source' } }),
        skill('modified', { modified: true, upstream: { state: 'current' } }),
        skill('off', { rules: [] }),
        skill('ok'),
      ], [], new Map()),
    ).toHaveLength(2);
  });

  it('builds one body per machine with a dot per reaching skill; offline keeps last-known dots quietly', () => {
    const noGemini = skill('no-gemini', {
      rules: [
        {
          id: 'on',
          skillId: 'no-gemini',
          target: { t: 'allMachines' },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'g',
          skillId: 'no-gemini',
          target: { t: 'allMachines' },
          agentId: 'gemini',
          enabled: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const reach = buildSkillsReach(
      [skill('every'), noGemini, skill('off', { rules: [] })],
      [
        machine('mbp', ['claude', 'gemini']),
        machine('nl2', ['gemini']),
        machine('win', ['claude'], true),
      ],
    );
    expect(
      reach.bodies.map((body) => [
        body.key,
        body.dots.map((dot) => `${dot.key}:${dot.tone}`),
      ]),
    ).toEqual([
      ['mbp', ['every:active', 'no-gemini:active']],
      ['nl2', ['every:active']],
      ['win', ['every:quiet', 'no-gemini:quiet']],
    ]);
    expect(reach.reachingCount).toBe(2);
    expect(reach.onlineReachedMachineCount).toBe(2);
    expect(reach.agentIds).toEqual(['claude', 'gemini']);
    expect(reach.offlineMachineIds).toEqual(['win']);
  });

  it('legend count: known Agents give a count even while the roster is incomplete; only an unknown roster is unknown', () => {
    const [known, unknown, offline] = buildSkillsReach(
      [skill('every'), skill('off', { rules: [] })],
      [
        { ...machine('mbp', ['claude', 'codex']), agentInventoryComplete: false },
        { ...machine('nl2', []), agentInventoryComplete: false },
        { ...machine('win', ['claude'], true), agentInventoryComplete: false },
      ],
    ).machines;
    expect(skillsReachLegendCount(known!, false)).toBe(1);
    expect(skillsReachLegendCount(offline!, false)).toBe(1);
    expect(skillsReachLegendCount(unknown!, false)).toBeNull();
    expect(skillsReachLegendCount(known!, true)).toBe(0);
  });

  it('a library holding only the built-in skill is new: the first-party item never counts as the person\'s own', () => {
    const builtIn = skill('happier:happier', { provenance: { kind: 'first_party' } });
    const reach = buildSkillsReach([builtIn], [machine('mbp', ['claude'])]);
    expect(resolveSkillsPresent({ items: [builtIn], reach, needs: 0, firstVisit: null })).toEqual({ kind: 'new' });
    expect(resolveSkillsPresent({ items: [builtIn, skill('pdf')], reach, needs: 0, firstVisit: null }).kind).not.toBe('new');
  });

  it('a plugin\'s skill is host-owned like the built-in one: it never makes the library the person\'s own', () => {
    const builtIn = skill('happier:happier', { provenance: { kind: 'first_party' } });
    const pluginOwned = skill('plugin:acme/check', { provenance: { kind: 'plugin', pluginId: 'acme', occurrenceId: 'o1' } });
    const reach = buildSkillsReach([builtIn, pluginOwned], [machine('mbp', ['claude'])]);
    expect(resolveSkillsPresent({ items: [builtIn, pluginOwned], reach, needs: 0, firstVisit: null })).toEqual({ kind: 'new' });
  });

  it('ranks reached machines before idle peers, including an older reached offline machine before a recently seen idle one', () => {
    const seen = (id: string, at: number): ReachMachine => ({ ...machine(id, ['claude'], true), lastSeenAt: at });
    const machines = [seen('old', 10), machine('idle', ['claude']), seen('recent', 50), machine('busy', ['claude']), machine('bare', [])];
    const orderBefore = machines.map(machine => machine.machineId);
    const reach = buildSkillsReach(
      [skill('every', { rules: ['busy', 'old'].map(machineId => ({ id: machineId, skillId: 'every',
        target: { t: 'machine', machineId }, enabled: true, createdAt: 1, updatedAt: 1 })) })],
      machines,
    );
    expect(reach.machines.map((row) => row.machine.machineId)).toEqual(['busy', 'idle', 'bare', 'old', 'recent']);
    expect(reach.bodies.map((body) => body.key)).toEqual(['busy', 'idle', 'bare', 'old', 'recent']);
    expect(reach.bodies.find(body => body.key === 'old')?.dots).toEqual([{ key: 'every', tone: 'quiet' }]);
    expect(machines.map(machine => machine.machineId)).toEqual(orderBefore);
  });

  it('folds machines past the room into one count, and folds none when all fit', () => {
    const rows = buildSkillsReach([], ['a', 'b', 'c', 'd', 'e'].map((id) => machine(id, ['claude']))).machines;
    const folded = foldReachMachines(rows, 4);
    expect(folded.shown.map((row) => row.machine.machineId)).toEqual(['a', 'b', 'c']);
    expect(folded.more).toBe(2);
    const fits = foldReachMachines(rows.slice(0, 4), 4);
    expect(fits.shown).toHaveLength(4);
    expect(fits.more).toBe(0);
  });

  it('first visit: a rule-less library with only migrated rules; any decided rule ends it', () => {
    const firstVisit = (items: readonly SkillListItemV1[]) => resolveSkillsFirstVisit(items,
      { rules: items.flatMap(item => item.rules), decidedAt: null });
    const migrated = skill('ctx', { migratedFromContext: true, rules: [{ id: 'migrated-stack:account:ctx', skillId: 'ctx',
      target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
    expect(
      firstVisit([
        migrated,
        skill('a', { rules: [] }),
        skill('b', { rules: [] }),
      ]),
    ).toEqual({ on: 1, off: 2 });
    expect(
      firstVisit([skill('decided'), skill('a', { rules: [] })]),
    ).toBeNull();
    expect(firstVisit([skill('all-on')])).toBeNull();
  });

  it('maps plugin provenance to its declared display name and leaves an unknown source absent', () => {
    const pluginId = 'com.acme.skills';
    const item = skill('plugin:com.acme.skills/check', { provenance: {
      kind: 'plugin', pluginId, occurrenceId: 'acme-runtime',
    } });
    const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
      installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Acme Skills', enabled: true,
        source: { kind: 'path', locator: '/plugins/acme' } } },
    }));
    const machineName = (id: string) => `Machine ${id}`;
    expect(skillSource(item, machineName, projection.installedPackagesById)).toEqual({ kind: 'plugin', pluginName: 'Acme Skills' });
    expect(skillSource(item, machineName, null)).toBeUndefined();
    expect(skillSource(item, machineName, normalizePluginUiProjection(null).installedPackagesById)).toBeUndefined();
  });

  it('maps provenance to one source: GitHub links and registries read as the repository', () => {
    const name = (id: string) => `name:${id}`;
    expect(skillSource(skill('w'), name)).toEqual({ kind: 'you' });
    expect(skillSource(skill('pick', { provenance: { kind: 'registry', registry: {
      sourceId: 'marketplace:3347a9078f85', format: 'happier-catalog', sourceUrl: 'https://marketplace.happier.dev/catalog.json',
      itemId: 'pick', importedAt: 1, ref: { kind: 'gitTree', repo: 'https://github.com/example/skills', path: 'review', commit: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    } } }), name)).toEqual({ kind: 'git', label: 'example/skills' });
    // A source outside GitHub reads as its host, never as the internal source id.
    expect(skillSource(skill('own', { provenance: { kind: 'registry', registry: {
      sourceId: 'registry:4d6524bab2a4', format: 'git', sourceUrl: 'https://git.example.com/team/skills.git',
      itemId: 'own', importedAt: 1, ref: { kind: 'gitTree', repo: 'https://git.example.com/team/skills.git', path: 'own', commit: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    } } }), name)).toEqual({ kind: 'git', label: 'git.example.com' });
    expect(
      skillSource(
        skill('l', {
          provenance: {
            kind: 'link',
            url: 'https://github.com/anthropics/skills/tree/main/pdf',
            ref: {
              kind: 'gitTree',
              repo: 'anthropics/skills',
              commit: 'a'.repeat(40),
              path: 'pdf',
              treeSha: 'b'.repeat(40),
            },
          },
        }),
        name,
      ),
    ).toEqual({ kind: 'git', label: 'anthropics/skills' });
    expect(
      skillSource(
        skill('m', {
          provenance: {
            kind: 'machine',
            machineId: 'mbp',
            agentIds: [],
            path: '~/.claude/skills/m',
            importedAt: 1,
          },
        }),
        name,
      ),
    ).toEqual({ kind: 'machine', machineName: 'name:mbp' });
  });

  it('uses the registry source name for a retained skill before falling back to a raw host', () => {
    const item = skill('private', { provenance: { kind: 'registry', registry: {
      sourceId: 'registry:team', format: 'happier-catalog', sourceUrl: 'https://skills.example.test:8443/catalog.json',
      itemId: 'private', importedAt: 1, ref: { kind: 'gitTree', repo: 'https://skills.example.test:8443/team.git',
        path: 'private', commit: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    } } });
    const sourceName = createSkillSourceNameResolver([{ id: 'registry:team', title: 'Team playbook', url: item.provenance.kind === 'registry' ? item.provenance.registry.sourceUrl : '' }]);
    expect(skillSource(item, id => id, null, sourceName(item)))
      .toEqual({ kind: 'registry', label: 'Team playbook' });
    expect(skillSource(item, id => id, null))
      .toEqual({ kind: 'git', label: 'skills.example.test:8443' });
    expect(sourceName({ provenance: { kind: 'wellKnown', indexUrl: 'https://skills.example.test:8443/catalog.json', name: 'private', digest: `sha256:${'a'.repeat(64)}` } }))
      .toBe('Team playbook');
    expect(sourceName({ provenance: { kind: 'wellKnown', indexUrl: 'https://skills.example.test:8443/another.json', name: 'private', digest: `sha256:${'a'.repeat(64)}` } }))
      .toBeUndefined();
  });
});

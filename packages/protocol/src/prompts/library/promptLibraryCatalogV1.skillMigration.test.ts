import { describe, expect, it } from 'vitest';
import { loadPromptLibraryCatalogV1 } from './promptLibraryCatalogV1.js';
import { PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema,
  sealPromptLibraryContentV1, openPromptLibraryContentV1, type PromptLibraryRecordV1, type PromptLibraryRowsListResponseV1Schema } from './promptLibraryRowsV1.js';
import capturedPicker from '../../../fixtures/0.2-picker-skill-instructions-stack.json';
import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1.js';
import { resolveSessionCapabilitiesV1 } from '../../reach/resolveSessionCapabilitiesV1.js';

/** Test adapter: drive the batched first-activation write through a per-record fake. */
function initializeEach(write: (input: Readonly<{ record: any; expectedRevision: 'absent'; sourceSettingsVersion: number }>) => Promise<any>) {
  return async (input: Readonly<{ records: readonly any[]; sourceSettingsVersion: number }>): Promise<any> => {
    const rows: Array<{ key: any; revision: number; cursor: number }> = [];
    for (const record of input.records) {
      const receipt = await write({ record, expectedRevision: 'absent', sourceSettingsVersion: input.sourceSettingsVersion });
      if (receipt.status !== 'updated') return receipt;
      rows.push({ key: record.key, revision: receipt.revision, cursor: receipt.cursor });
    }
    return { status: 'updated', rows };
  };
}

// Observed ../0.2 cd2bb4d853: promptLibrary/promptStacksV1.ts stores editPolicy
// and both placements; bundle headers identify the schema (not the placement).
const predecessor = {
  v: 1, futureStackField: true, surfaces: {
    coding: [
      { id: 'instructions', ref: { kind: 'bundle', artifactId: 'lint', futureRefField: true }, enabled: true, placement: 'skill_instructions', editPolicy: 'user_only' },
      { id: 'append', ref: { kind: 'bundle', artifactId: 'review' }, enabled: true, placement: 'system_append', editPolicy: 'agent_may_propose_requires_approval' },
      { id: 'disabled', ref: { kind: 'bundle', artifactId: 'disabled-skill' }, enabled: false, placement: 'skill_instructions', editPolicy: 'user_only' },
      { id: 'generic', ref: { kind: 'bundle', artifactId: 'generic' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
    ],
    voice: [{ id: 'voice-skill', ref: { kind: 'bundle', artifactId: 'voice-only' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' }],
    profilesById: { work: [{ id: 'profile', ref: { kind: 'bundle', artifactId: 'lint' }, enabled: true, placement: 'skill_instructions' }] },
  },
};

function harness(options: { unreadableRules?: boolean; interruptVoice?: boolean; artifactUnavailable?: boolean } = {}) {
  const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = [];
  if (options.unreadableRules) rows.push({ key: 'skill-rules', revision: 1, content: { t: 'plain', v: { broken: true } } });
  let raw: Readonly<Record<string, unknown>> = { promptStacksV1: predecessor, unrelated: 'keep' };
  const writes: PromptLibraryRecordV1[] = [];
  let interrupted = false;
  const writeRecord = async (input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }) => {
    // Real mutation producer is consumed by the exact closed wire schema.
    const wire = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
      content: sealPromptLibraryContentV1({ mode: 'plain', material: null, record: input.record }),
      ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) });
    const index = rows.findIndex(row => row.key === input.record.key);
    const current = index < 0 ? 'absent' : rows[index]!.revision;
    if (wire.expectedRevision !== current) return PromptLibraryRowMutationResponseV1Schema.parse({ status: 'conflict', revision: current === 'absent' ? -1 : current });
    if (options.interruptVoice && !interrupted && input.record.key === 'voice' && input.record.value.entries.length === 0) {
      interrupted = true; throw new Error('Disconnected after rules acknowledgment');
    }
    const revision = current === 'absent' ? 1 : current + 1;
    const row = { key: input.record.key, revision, content: wire.content };
    if (index < 0) rows.push(row); else rows[index] = row;
    writes.push(input.record);
    return PromptLibraryRowMutationResponseV1Schema.parse({ status: 'updated', revision, cursor: writes.length });
  };
  const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
    readRows: async () => ({ status: 'listed', rows }),
    nowMs: () => 100,
    skillMigration: { writeRecord,
      readArtifact: async ref => options.artifactUnavailable ? null : ({ header: {
        v: 1, kind: 'prompt_bundle.v2', title: ref.artifactId,
        bundleSchemaId: ref.artifactId === 'generic' ? 'bundle.generic_v1' : 'skills.skill_md_v1', futureHeader: true,
      } }),
    }, transfer: { readSourceSnapshot: async () => ({ raw, version: 7 }), initializeRecords: initializeEach(writeRecord),
      replaceSource: async input => { raw = input.raw; return { status: 'applied', settingsVersion: 8 }; },
      normalizeHistory: async () => ({ status: 'complete' }),
    },
  });
  return { load, writes, rows, record: (key: string) => rows.find(row => row.key === key)?.content };
}

describe('predecessor stack → canonical skill destinations', () => {
  it('loads the real 0.2 picker golden through catalog CAS and reach without pasting or deleting its skill', async () => {
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = [];
    let writes = 0;
    const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null, nowMs: () => 100,
      readRows: async () => ({ status: 'listed', rows }),
      transfer: { readSourceSnapshot: async () => ({ raw: { promptStacksV1: capturedPicker.stacks }, version: 7 }),
        initializeRecords: initializeEach(writeRecord) },
      skillMigration: { writeRecord, readArtifact: async ref => capturedPicker.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null },
    });
    async function writeRecord(input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }) {
      const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
        content: sealPromptLibraryContentV1({ mode: 'plain', material: null, record: input.record }),
        ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) });
      const index = rows.findIndex(row => row.key === input.record.key);
      const previous = index < 0 ? 'absent' : rows[index]!.revision;
      expect(mutation.expectedRevision).toBe(previous);
      const revision = previous === 'absent' ? 1 : previous + 1;
      const row = { key: input.record.key, content: mutation.content, revision };
      if (index < 0) rows.push(row); else rows[index] = row;
      return PromptLibraryRowMutationResponseV1Schema.parse({ status: 'updated', revision, cursor: ++writes });
    }
    const catalog = await load();
    if (catalog.status !== 'ready') throw new Error('Golden catalog unavailable');
    const coding = catalog.rows.find(row => row.record.key === 'coding')?.record;
    const rules = catalog.rows.find(row => row.record.key === 'skill-rules')?.record;
    if (coding?.key !== 'coding' || rules?.key !== 'skill-rules') throw new Error('Missing golden destinations');
    expect(rules.value).toMatchObject({ consumedLegacyEntryIds: ['migrated-stack:account:skill-entry'] });
    expect(openPromptLibraryContentV1({ key: 'skill-rules', mode: 'plain', material: null,
      content: { t: 'plain', v: { ...rules, futureRecord: true, value: { ...rules.value, futureRules: true } } } }))
      .toEqual({ status: 'opened', record: rules });
    expect(coding.value.entries.map(entry => entry.id)).toEqual(['before-entry', 'skill-entry', 'after-entry']);
    const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix',
      directory: '/repo', projectKey: null, agentId: 'claude' }, mcp: null, agentAcceptsUserMcp: true,
      skills: { items: [{ skillId: 'session-control-skill', name: 'session-control' }, { skillId: 'unused-library-skill', name: 'unused' }], rules: rules.value.rules }, selection: {} });
    expect(selected.skills.items.map(item => [item.id, item.selected])).toEqual([['session-control-skill', true], ['unused-library-skill', false]]);
    expect((await resolvePromptStackSystemAppendBlocksV1({ surface: 'coding', accountEntries: coding.value.entries,
      readArtifact: async ref => capturedPicker.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null })).blocks)
      .toEqual(['Before the skill: preserve the working tree.', 'After the skill: report the checks actually run.']);
    const count = writes;
    await load();
    expect(writes).toBe(count);
    await writeRecord({ record: { ...rules, value: { ...rules.value,
      rules: rules.value.rules.filter(rule => rule.skillId !== 'session-control-skill') } },
      expectedRevision: catalog.rows.find(row => row.record.key === 'skill-rules')!.revision });
    const afterRemoval = writes;
    for (let pass = 0; pass < 2; pass++) {
      const reloaded = await load();
      if (reloaded.status !== 'ready') throw new Error('Golden reload unavailable');
      const destination = reloaded.rows.find(row => row.record.key === 'skill-rules')?.record;
      if (destination?.key !== 'skill-rules') throw new Error('Golden rules unavailable');
      expect(destination.value.rules.some(rule => rule.skillId === 'session-control-skill')).toBe(false);
      expect(writes).toBe(afterRemoval);
    }
  });
  it('adds deterministic Account rules, keeps inert legacy rows, drops voice and keeps generic content', async () => {
    const h = harness();
    expect(await h.load()).toMatchObject({ status: 'ready' });
    expect(h.record('skill-rules')).toMatchObject({ t: 'plain', v: { value: { rules: expect.arrayContaining([
      { skillId: 'lint', id: 'migrated-stack:account:instructions', target: { t: 'allMachines' }, enabled: true, createdAt: 100, updatedAt: 100 },
      { skillId: 'review', id: 'migrated-stack:account:append', target: { t: 'allMachines' }, enabled: true, createdAt: 100, updatedAt: 100 },
    ]) } } });
    const rules = h.rows.find(row => row.key === 'skill-rules')!.content;
    expect(rules).toMatchObject({ t: 'plain', v: { value: { consumedLegacyEntryIds: [
      'migrated-stack:account:instructions', 'migrated-stack:account:append',
    ] } } });
    expect(JSON.stringify(rules)).not.toContain('disabled-skill');
    expect(JSON.stringify(rules)).not.toContain('voice-only');
    expect(h.record('coding')).toMatchObject({ t: 'plain', v: { value: { entries: predecessor.surfaces.coding.map(entry => expect.objectContaining({ id: entry.id })) } } });
    expect(h.record('voice')).toMatchObject({ t: 'plain', v: { value: { entries: [] } } });
    const count = h.writes.length;
    await h.load();
    expect(h.writes).toHaveLength(count);
  });
  it('converges after destination acknowledgement but voice drop interruption without changing coding custody', async () => {
    const h = harness({ interruptVoice: true });
    await h.load();
    expect(h.record('coding')).toMatchObject({ t: 'plain', v: { value: { entries: expect.arrayContaining([{ id: 'instructions', ref: { kind: 'bundle', artifactId: 'lint' }, enabled: true, placement: 'skill_instructions' }]) } } });
    await h.load();
    expect(h.record('voice')).toMatchObject({ t: 'plain', v: { value: { entries: [] } } });
    expect(h.record('coding')).toMatchObject({ t: 'plain', v: { value: { entries: expect.arrayContaining([expect.objectContaining({ id: 'instructions' })]) } } });
    expect(h.writes.filter(record => record.key === 'skill-rules' && record.value.rules.some(rule => rule.id === 'migrated-stack:account:instructions'))).toHaveLength(1);
  });
  it('consumes an entry already covered by a user Off rule in the same destination CAS', async () => {
    const h = harness();
    const rule = { id: 'user-off', skillId: 'lint', target: { t: 'allMachines' as const }, enabled: false, createdAt: 1, updatedAt: 2 };
    h.rows.push({ key: 'skill-rules', revision: 4, content: sealPromptLibraryContentV1({ mode: 'plain', material: null,
      record: { key: 'skill-rules', value: { v: 1, rules: [rule] } } }) });
    h.rows.push({ key: 'coding', revision: 2, content: sealPromptLibraryContentV1({ mode: 'plain', material: null,
      record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [
        { id: 'instructions', ref: { kind: 'bundle', artifactId: 'lint' }, enabled: true, placement: 'skill_instructions' },
      ] } } }) });
    const catalog = await h.load();
    if (catalog.status !== 'ready') throw new Error('Missing migrated Account');
    const destination = catalog.rows.find(row => row.record.key === 'skill-rules')?.record;
    if (destination?.key !== 'skill-rules') throw new Error('Missing rules');
    expect(destination.value).toEqual({ v: 1, rules: [rule], consumedLegacyEntryIds: ['migrated-stack:account:instructions'] });
    expect(h.writes.filter(record => record.key === 'skill-rules')).toHaveLength(1);
    const count = h.writes.length;
    await h.load();
    expect(h.writes).toHaveLength(count);
  });
  it('drops voice skill entries without enabling voice-only skills or deleting library content', async () => {
    const h = harness();
    await h.load();
    expect(h.record('voice')).toMatchObject({ t: 'plain', v: { value: { entries: [] } } });
    expect(h.record('coding')).toMatchObject({ t: 'plain', v: { value: { entries: expect.arrayContaining([
      expect.objectContaining({ id: 'instructions' }), expect.objectContaining({ id: 'generic' }),
    ]) } } });
    expect(JSON.stringify(h.record('skill-rules'))).not.toContain('voice-only');
    const count = h.writes.length;
    await h.load();
    expect(h.writes).toHaveLength(count);
  });
  it.each([{ unreadableRules: true }, { artifactUnavailable: true }])('retains source entries when classification or destination is unavailable: %j', async options => {
    const h = harness(options);
    expect(await h.load()).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining([
      expect.objectContaining({ key: 'coding', reason: 'unreachable' }),
    ]) });
    expect(h.record('coding')).toMatchObject({ t: 'plain', v: { value: { entries: expect.arrayContaining([{ id: 'instructions', ref: { kind: 'bundle', artifactId: 'lint' }, enabled: true, placement: 'skill_instructions' }]) } } });
    expect(h.writes.filter(record => record.key === 'coding')).toHaveLength(1);
  });
});

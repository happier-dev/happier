import { describe, expect, it } from 'vitest';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1 } from './promptLibraryCatalogV1.js';
import { PromptLibraryCatalogKeyV1Schema, type PromptLibraryRecordV1, type PromptLibraryRowsListResponseV1Schema } from './promptLibraryRowsV1.js';
import { mutateSkillRulesV1 } from './skillRulesActionsV1.js';
import { readSkillLibraryCatalog } from './skills/readSkillLibraryCatalog.js';

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

describe('first-party skill rules initial content', () => {
  it('seeds only an absent row; reload, Off, removal, pre-existing empty row and deletion never reseed', async () => {
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] =
      PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'skill-rules').map(key => ({ key, revision: 1,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } }));
    const writes: PromptLibraryRecordV1[] = [];
    const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => ({ status: 'listed', rows }),
      transfer: { readSourceSnapshot: async () => ({ raw: {}, version: 7 }), initializeRecords: initializeEach(async input => {
        writes.push(input.record); rows.push({ key: input.record.key, revision: 1, content: { t: 'plain', v: input.record } });
        return { status: 'updated', revision: 1, cursor: 1 };
      }) } });
    const first = await load();
    expect(readPromptLibraryCatalogRecordV1({ catalog: first, key: 'skill-rules' })).toMatchObject({ status: 'ready',
      record: { value: { rules: [{ id: 'first-party:happier:happier', skillId: 'happier:happier', target: { t: 'allMachines' }, enabled: true }] } } });
    await load();
    expect(writes).toHaveLength(1);
    const index = rows.findIndex(row => row.key === 'skill-rules');
    const record = writes[0]!;
    if (record.key !== 'skill-rules') throw new Error('Expected skills row');
    const port = {
      serverId: 'home', matchesServerId: (serverId: string) => serverId === 'home', assertCurrent: () => {},
      readCatalog: async () => ({ catalog: await load() }),
      listSkills: () => readSkillLibraryCatalog({ list: async () => ({ items: [], coverage: 'complete' }) }),
      ruleWriteContext: () => ({ nowMs: 100, newId: () => 'user-rule' }),
      writeRecord: async (input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }) => {
        if (input.expectedRevision !== rows[index]!.revision) return { status: 'conflict' as const, revision: rows[index]!.revision };
        rows[index] = { key: 'skill-rules', revision: rows[index]!.revision + 1, content: { t: 'plain', v: input.record } };
        return { status: 'updated' as const, revision: rows[index]!.revision, cursor: 2 };
      },
    };
    expect(await mutateSkillRulesV1(port, { items: [{ name: 'happier' }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } })).toMatchObject({ ok: true });
    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'skill-rules' })).toMatchObject({ record: { value: { rules: [{ enabled: false }] } } });
    expect(await mutateSkillRulesV1(port, { items: [{ skillId: 'happier:happier' }], change: { kind: 'replace', rules: [] } })).toMatchObject({ ok: true });
    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'skill-rules' })).toMatchObject({ record: { value: { rules: [] } } });
    rows[index] = { key: 'skill-rules', revision: 4, content: null };
    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'skill-rules' })).toMatchObject({ record: { value: { rules: [] } } });
    rows[index] = { key: 'skill-rules', revision: 5, content: { t: 'plain', v: { invalid: true } } };
    expect((await load()).status).toBe('partial');
    expect(writes).toHaveLength(1);
  });
});

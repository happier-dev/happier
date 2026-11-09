import { describe, expect, it } from 'vitest';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { SkillCatalogItemV1Schema } from '@happier-dev/protocol/runtime/catalog/skills';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { buildSkillComposerGroups, pickSkillComposerRow } from './skillComposerGroups';

const skill = (skillId: string, name: string, userInvocable = true) => SkillListItemV1Schema.parse({ skillId, name,
    description: 'Useful capability', revision: '1:1', rules: [], trust: 'text_only', cost: { bodyTokens: 1, descriptionTokens: 1 },
    provenance: { kind: 'written' }, modified: false, updatePolicy: 'manual', createdAt: 1,
    migratedFromContext: false, userInvocable, folderId: null });
const found = { machineId: 'm', observedAt: 99, result: SkillFoundListResultV1Schema.parse({ scannedAt: 99, roots: [], items: [
    { name: 'native', description: null, path: '/skills/native', digest: 'digest', agents: ['codex'], scope: 'user', inLibrary: null,
        masksLibrary: false, happierInstalled: false, pluginOwned: null },
    { name: 'other-agent', description: null, path: '/skills/other', digest: 'other', agents: ['claude'], scope: 'user', inLibrary: null,
        masksLibrary: false, happierInstalled: false, pluginOwned: null },
] }) };

describe('composer skill groups', () => {
    it('writes a Found skill selection with an inline token and the grouped canonical identity', async () => {
        const row = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'm',
            sessionItems: [], libraryItems: [], found }).flatMap(group => group.rows)[0]!;
        expect(await pickSkillComposerRow(row, {
            setItem: () => { throw new Error('A Found skill does not mutate the library selection'); },
        })).toEqual({ ok: true, mention: { kind: 'happier.skill', ref: 'skill:vendor:codex:native',
            token: '[native](happier-ref:skill:vendor:codex:native)', label: 'native' } });
    });
    it.each([undefined, true])('does not resurrect a non-invocable Session identity from weaker Found data (%s)', userInvocable => {
        const groups = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'm',
            sessionItems: [SkillCatalogItemV1Schema.parse({ name: 'native', origin: 'vendor', backendId: 'codex', userInvocable: false })],
            libraryItems: [skill('different-identity', 'native')],
            found: { ...found, result: { ...found.result, items: found.result.items.map(item => ({ ...item, userInvocable })) } } });
        expect(groups.map(group => group.kind)).toEqual(['library']);
        expect(groups.flatMap(group => group.rows.map(row => row.identity.id))).toEqual(['different-identity']);
    });
    it('omits a non-invocable Found skill without a Session catalog and accepts a missing invocation flag', () => {
        const native = found.result.items[0]!;
        const groups = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'm',
            sessionItems: [], libraryItems: [], found: { ...found, result: { ...found.result, items: [
                { ...native, name: 'hidden', userInvocable: false }, native,
            ] } } });
        expect(groups.flatMap(group => group.rows.map(row => row.name))).toEqual(['native']);
    });
    it('unifies canonical identities, filters user invocation and machine/Agent scope, and preserves dated Found data', () => {
        const session = SkillCatalogItemV1Schema.parse({ name: 'already', id: 'library-a', origin: 'happier', backendId: 'codex' });
        const groups = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'm',
            sessionItems: [session], libraryItems: [skill('library-a', 'already'), skill('library-b', 'pick-me'), skill('hidden', 'hidden', false)], found });
        expect(groups.map(group => group.kind)).toEqual(['session', 'library', 'found']);
        expect(groups.flatMap(group => group.rows.map(row => row.name))).toEqual(['already', 'pick-me', 'native']);
        expect(groups[2]).toMatchObject({ machineId: 'm', observedAt: 99 });
        const unrelated = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'other', sessionItems: [], libraryItems: [], found });
        expect(unrelated.flatMap(group => group.rows)).toEqual([]);
    });
    it('does no projection work for a closed picker and offers disable-model-invocation skills from the real list producer', async () => {
        const closed = { open: false, query: '', agentId: 'codex', machineId: 'm', found,
            get sessionItems(): readonly unknown[] { throw new Error('Unopened picker touched session catalog'); },
            get libraryItems(): readonly never[] { throw new Error('Unopened picker touched library'); } };
        expect(buildSkillComposerGroups(closed)).toEqual([]);
        const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'manual', bundleSchemaId: 'skills.skill_md_v1' });
        const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
            contentBase64: encodeBase64(new TextEncoder().encode('---\nname: manual\ndescription: Only invoked by you\ndisable-model-invocation: true\n---\nBody')) }] });
        const list = createSkillActionExecuteV1({ store: { list: async () => ({ items: [{ id: 'manual', header, updatedAtMs: 1 }], coverage: 'complete' }),
            read: async () => ({ id: 'manual', header, body: JSON.stringify(body), revision: { headerVersion: 1, bodyVersion: 1 } }),
            update: async () => { throw new Error('read only'); } },
            skillRules: { serverId: 'home', assertCurrent: () => {}, readCatalog: async () => ({ catalog: { status: 'ready', rows: [
                { record: { key: 'skill-rules', value: { v: 1, rules: [] } }, revision: 1 }], tombstones: [], diagnostics: [] } }),
                listSkills: async () => [], ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }),
                writeRecord: async () => { throw new Error('read only'); } }, randomId: () => 'id', includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }) });
        const produced = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await list('skills.list', {}, { surface: 'ui' }));
        expect(buildSkillComposerGroups({ open: true, query: 'manual', agentId: 'codex', machineId: null, sessionItems: [],
            libraryItems: produced.items, found: null }).flatMap(group => group.rows.map(row => row.name))).toEqual(['manual']);
    });
});

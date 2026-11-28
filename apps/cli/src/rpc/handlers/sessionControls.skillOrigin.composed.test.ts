import { describe, expect, it } from 'vitest';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SkillCatalogItemV1Schema } from '@happier-dev/protocol/runtime/catalog/skills';
import { resolveHappierSkillIdentity } from '@/prompts/skills/runtime/resolveHappierSkillIdentity';
import { registerSessionControlHandlers } from './sessionControls';
import { listCodexAppServerSkills } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/catalog/index';
import { configuration } from '@/configuration';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildSkillComposerGroups } from '../../../../ui/sources/sync/domains/skills/skillComposerGroups';
import { join } from 'node:path';
import { homedir } from 'node:os';

const digest = `sha256:${'a'.repeat(64)}`;
const delivery = { pluginRoot: '/happier/skills/sessions/session', skillsRoot: '/happier/skills/sessions/session/skills',
  items: [{ name: 'sample', skillId: 'library', digest, directory: '/happier/skills/sessions/session/skills/source-sample' }], nativeDisables: [] };

describe('current Session skill origin', () => {
  it('recognizes session and canonical cache paths but never a same-name native or sibling path', () => {
    expect(resolveHappierSkillIdentity({ name: 'sample', path: `${delivery.skillsRoot}/source-sample/SKILL.md` }, delivery, '/happier')).toBe('library');
    expect(resolveHappierSkillIdentity({ path: `/happier/skills/cache/${'a'.repeat(64)}/SKILL.md` }, delivery, '/happier')).toBe('library');
    for (const path of ['/native/sample/SKILL.md', `${delivery.skillsRoot}/source-sample2/SKILL.md`, `${delivery.skillsRoot}/sample/SKILL.md`,
      `${delivery.skillsRoot}/source-sample/../../native/SKILL.md`, `/happier/skills/cache/${'b'.repeat(64)}/SKILL.md`]) {
      expect(resolveHappierSkillIdentity({ name: 'sample', path }, delivery, '/happier')).toBeNull();
    }
    expect(resolveHappierSkillIdentity({ name: 'happier:sample' }, delivery, '/happier')).toBe('library');
    expect(resolveHappierSkillIdentity({ name: 'sample' }, undefined, '/happier')).toBeNull();
    const windows = { ...delivery, pluginRoot: 'C:\\Happier\\skills\\sessions\\session', skillsRoot: 'C:\\Happier\\skills\\sessions\\session\\skills',
      items: [{ ...delivery.items[0]!, directory: 'C:\\Happier\\skills\\sessions\\session\\skills\\source-sample' }] };
    expect(resolveHappierSkillIdentity({ path: 'c:/HAPPIER/skills/sessions/session/skills/source-sample\\SKILL.md' }, windows, 'C:\\Happier')).toBe('library');
    expect(resolveHappierSkillIdentity({ path: 'c:/HAPPIER/skills/sessions/session/skills/source-sample2\\SKILL.md' }, windows, 'C:\\Happier')).toBeNull();
    const userRoot = join(homedir(), '.happier');
    const userDelivery = { ...delivery, skillsRoot: join(userRoot, 'skills', 'sessions', 'session', 'skills') };
    for (const path of ['~/.happier/skills/cache/' + 'a'.repeat(64) + '/SKILL.md',
      '~\\.happier\\skills\\cache\\' + 'a'.repeat(64) + '\\SKILL.md']) {
      expect(resolveHappierSkillIdentity({ path }, userDelivery, userRoot)).toBe('library');
    }
  });

  it('annotates actual registered catalog output from the current delivery and preserves native identities', async () => {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    const sessionDelivery = { ...delivery, pluginRoot: join(configuration.happyHomeDir, 'skills', 'sessions', 'session'),
      skillsRoot: join(configuration.happyHomeDir, 'skills', 'sessions', 'session', 'skills') };
    let current: typeof sessionDelivery | undefined = sessionDelivery;
    // Only Codex's JSON-RPC transport is substituted; its actual catalog producer remains real.
    const catalog = await listCodexAppServerSkills({ cwd: '/repo', client: { request: async () => ({ data: [{ skills: [
      { name: 'sample', path: join(configuration.happyHomeDir, 'skills', 'cache', 'a'.repeat(64), 'SKILL.md') },
      { name: 'native', path: '/native/native/SKILL.md' },
      { description: 'An invalid native record is not a catalog identity' },
    ] }] }) } });
    const producer = catalog.skills.map(item => SkillCatalogItemV1Schema.parse(item));
    let currentCatalog = producer;
    let unsupported = false;
    expect(producer).toHaveLength(2);
    registerSessionControlHandlers(registrar, { sessionRuntimeControls: {
      listSkills: async () => ({ skills: currentCatalog, ...(unsupported ? { unsupported: true } : {}) }), readSkillDelivery: () => current,
    } });
    const read = async () => {
      const result = await handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)!({});
      expect(result).toMatchObject({ skills: expect.any(Array) });
      const skills: unknown = result && typeof result === 'object' ? Reflect.get(result, 'skills') : undefined;
      if (!Array.isArray(skills)) throw new Error('Missing catalog');
      return skills.map(item => SkillCatalogItemV1Schema.parse(item));
    };
    const skills = await read();
    expect(skills[0]).toMatchObject({ id: 'library', origin: 'happier', projectionRef: 'library' });
    const libraryItem = SkillListItemV1Schema.parse({ skillId: 'library', name: 'sample', description: null,
      revision: '1:1', rules: [], trust: 'text_only', cost: { bodyTokens: 1, descriptionTokens: 0 }, provenance: { kind: 'written' },
      modified: false, updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null });
    // Real Codex producer → registered host annotation → canonical catalog → exact picker consumer.
    expect(buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: null,
      sessionItems: skills, libraryItems: [libraryItem], found: null }).some(group => group.kind === 'library')).toBe(false);
    expect(skills[1]).toEqual(producer[1]);
    const nativeCatalog = await listCodexAppServerSkills({ cwd: '/repo', client: { request: async () => ({ data: [{ skills: [
      { name: 'sample', path: '/native/sample/SKILL.md' },
    ] }] }) } });
    currentCatalog = nativeCatalog.skills.map(item => SkillCatalogItemV1Schema.parse(item));
    expect(await read()).toEqual(currentCatalog);
    // A delivery acknowledgement cannot invent native discovery.
    currentCatalog = [];
    expect(await read()).toEqual([]);
    current = { ...sessionDelivery, items: [{ ...sessionDelivery.items[0]!, directory: '/replacement/source-sample' }] };
    currentCatalog = [{ ...producer[0]!, path: join('/replacement/source-sample', 'SKILL.md') }];
    expect(await read()).toEqual([expect.objectContaining({ id: 'library', origin: 'happier', path: join('/replacement/source-sample', 'SKILL.md') })]);
    current = undefined;
    expect(await read()).toEqual(currentCatalog);
    current = sessionDelivery;
    currentCatalog = [];
    unsupported = true;
    expect(await handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)!({})).toEqual({ unsupported: true, skills: [] });
    unsupported = false;
    currentCatalog = producer;
    current = { ...sessionDelivery, items: [] };
    expect((await read())[0]).toEqual(producer[0]);
  });
});

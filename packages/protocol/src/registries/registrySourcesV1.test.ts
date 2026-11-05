import { describe, expect, it } from 'vitest';
import { deriveRegistrySourceIdV1, HAPPIER_PICKS_SOURCE_ID, listRegistrySourcesV1, normalizeRegistrySourceUrlV1, readRegistrySourcesRecordV1,
  RegistrySourceDescriptorV1Schema, RegistrySourcesRecordV1Schema, RegistrySourceV1Schema } from './registrySourcesV1.js';
import { openPromptLibraryContentV1, PromptLibraryRecordV1Schema } from '../prompts/library/promptLibraryRowsV1.js';
import { REGISTRY_ACTION_INPUT_SCHEMAS_V1 } from './registryActionsV1.js';

const configuredSource = RegistrySourceV1Schema.parse({
  id: 'marketplace:private', title: 'Private catalog', format: 'happier-catalog', kinds: ['plugin'],
  url: 'https://catalog.example/index.json', enabled: true, addedAt: 1,
});

describe('registry source write contracts', () => {
  it('admits app-only template formats through the source and Action contracts', () => {
    for (const format of ['coolify-templates', 'dokploy-templates']) {
      const source = { ...configuredSource, format, kinds: ['app'] };
      expect(RegistrySourceV1Schema.safeParse(source).success).toBe(true);
      for (const kind of ['skill', 'mcpServer', 'agent', 'plugin', 'unknown']) {
        expect(RegistrySourceV1Schema.safeParse({ ...source, kinds: [kind] }).success).toBe(false);
      }
    }
    expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.items.list'].parse({ kind: 'app' })).toEqual({ kind: 'app' });
    expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.items.read'].parse({ kind: 'app', sourceId: 'apps', itemId: 'postgres', version: '1' }))
      .toEqual({ kind: 'app', sourceId: 'apps', itemId: 'postgres', version: '1' });
  });

  it('preserves large valid configuration and every source beyond the former marketplace count limit', () => {
    const source = { ...configuredSource, id: `registry:${'source'.repeat(100)}`, title: 'title'.repeat(200),
      url: `https://catalog.example/index.json?key=${'x'.repeat(3_000)}` };
    const sources = Array.from({ length: 70 }, (_, index) => ({ ...source, id: `${source.id}-${index}`,
      url: `https://source-${index}.example/index.json?key=${'x'.repeat(3_000)}` }));
    const record = { v: 2, sources, disabledSourceIds: [] };
    expect(RegistrySourcesRecordV1Schema.parse(record)).toEqual(record);
    expect(PromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: record }).value).toEqual(record);
    const input = { url: source.url, title: source.title, kinds: source.kinds };
    expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.create'].parse(input)).toEqual(input);
  });

  it('requires explicit row and source authority instead of supplying persisted defaults', () => {
    const record = { v: 2, sources: [configuredSource], disabledSourceIds: [] };
    for (const key of ['v', 'sources', 'disabledSourceIds']) {
      expect(RegistrySourcesRecordV1Schema.safeParse(Object.fromEntries(Object.entries(record)
        .filter(([name]) => name !== key))).success).toBe(false);
    }
    for (const key of ['enabled', 'format', 'kinds', 'addedAt']) {
      const source = Object.fromEntries(Object.entries(configuredSource).filter(([name]) => name !== key));
      expect(RegistrySourcesRecordV1Schema.safeParse({ ...record, sources: [source] }).success).toBe(false);
    }
    const descriptor = { ...configuredSource, origin: { kind: 'user' }, removable: true };
    expect(RegistrySourceDescriptorV1Schema.parse(descriptor)).toEqual(descriptor);
    for (const key of ['origin', 'removable']) {
      expect(RegistrySourceDescriptorV1Schema.safeParse(Object.fromEntries(Object.entries(descriptor)
        .filter(([name]) => name !== key))).success).toBe(false);
    }
  });

  it('rejects unknown source, row, descriptor, and origin authority fields on new writes', () => {
    for (const extra of [{ futureSourceFlag: true }, { origin: { kind: 'built_in' } }, { removable: false }]) {
      expect(RegistrySourceV1Schema.safeParse({ ...configuredSource, ...extra }).success).toBe(false);
      expect(RegistrySourcesRecordV1Schema.safeParse({ v: 2, sources: [{ ...configuredSource, ...extra }], disabledSourceIds: [] }).success).toBe(false);
    }
    expect(RegistrySourcesRecordV1Schema.safeParse({ v: 2, sources: [configuredSource], disabledSourceIds: [], futureRegistryFlag: true }).success).toBe(false);
    expect(RegistrySourceDescriptorV1Schema.safeParse({ ...configuredSource, origin: { kind: 'user' }, removable: true, futureDescriptorFlag: true }).success).toBe(false);
    expect(RegistrySourceDescriptorV1Schema.safeParse({ ...configuredSource, origin: { kind: 'user', pluginId: 'spoofed' }, removable: true }).success).toBe(false);
  });

  it('keeps optional opaque npm profile bindings and refuses credentials in catalog URLs', () => {
    expect(RegistrySourceV1Schema.parse(configuredSource).npmRegistryProfileId).toBeUndefined();
    expect(RegistrySourceV1Schema.parse({ ...configuredSource, npmRegistryProfileId: 'registry_private' }))
      .toMatchObject({ npmRegistryProfileId: 'registry_private' });
    for (const url of ['http://catalog.example/index.json', 'https://token@catalog.example/index.json']) {
      expect(RegistrySourceV1Schema.safeParse({ ...configuredSource, url }).success).toBe(false);
    }
  });

  it('admits fine-grained edits without accepting caller-owned source identity or origin', () => {
    expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.update'].parse({ sourceId: configuredSource.id, enabled: false }))
      .toEqual({ sourceId: configuredSource.id, enabled: false });
    expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.token.set'].parse({ sourceId: configuredSource.id, npmRegistryProfileId: null }))
      .toEqual({ sourceId: configuredSource.id, npmRegistryProfileId: null });
    for (const extra of [{ sourceId: 'forged' }, { origin: { kind: 'built_in' } }, { enabled: false }]) {
      expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.create'].safeParse({ url: configuredSource.url, ...extra }).success).toBe(false);
    }
    expect(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.delete'].safeParse({ sourceId: configuredSource.id, registry: { sources: [] } }).success).toBe(false);
  });
});

describe('Account registry sources', () => {
  // cd2bb4d853a259ae00ebc3e5981224e3e4bb5380: src/promptLibrary/promptRegistriesV1.ts.
  const predecessor = { v: 1, sources: [{ id: 'team', adapterId: 'git', title: 'Team', enabled: true,
    config: { repositoryUrl: 'git@github.com:team/skills.git', subdirectory: 'skills' } }, { id: 'bad' }] };
  it('reads predecessor sources individually, preserves identity, and writes the strict current row', () => {
    const record = readRegistrySourcesRecordV1(predecessor);
    expect(PromptLibraryRecordV1Schema.safeParse({key:'registry-sources',value:predecessor}).success).toBe(false);
    expect(record).toEqual({ v: 2, disabledSourceIds: [], sources: [{ id: 'team', title: 'Team', enabled: true,
      format: 'git', kinds: ['skill'], url: 'git@github.com:team/skills.git', path: 'skills', addedAt: 0 }] });
    expect(PromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: record }).value).toEqual(record);
    expect(openPromptLibraryContentV1({ key: 'registry-sources', mode: 'plain', material: null,
      content: { t: 'plain', v: { key: 'registry-sources', value: predecessor } } })).toMatchObject({ status: 'opened', record: { value: record } });
    expect(openPromptLibraryContentV1({key:'registry-sources',mode:'plain',material:null,content:{t:'plain',v:{key:'registry-sources',value:{...record,future:'drop',sources:record.sources.map(source=>({...source,future:'drop'}))}}}})).toEqual({status:'opened',record:{key:'registry-sources',value:record}});
  });
  it('normalizes repository identity and applies disabled state to non-user sources', () => {
    expect(normalizeRegistrySourceUrlV1('https://GitHub.com/acme/skills.git/')).toBe('https://github.com/acme/skills');
    expect(deriveRegistrySourceIdV1('https://GitHub.com/acme/skills.git')).toBe(deriveRegistrySourceIdV1('https://github.com/acme/skills'));
    expect(() => normalizeRegistrySourceUrlV1('https://secret@github.com/acme/skills')).toThrow();
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: ['builtin:skills-sh'] }, pluginSources: [] });
    expect(sources.find(source=>source.id==='builtin:skills-sh')).toMatchObject({ id: 'builtin:skills-sh', enabled: false, removable: false, origin: { kind: 'built_in' } });
  });
  it('projects curated defaults once without letting stored entries replace built-in authority', () => {
    const record = { v: 2 as const, sources: [{ ...configuredSource, id: HAPPIER_PICKS_SOURCE_ID }, configuredSource],
      disabledSourceIds: [HAPPIER_PICKS_SOURCE_ID, configuredSource.id] };
    const sources = listRegistrySourcesV1({ record, pluginSources: [] });
    expect(sources.filter(source => source.id === HAPPIER_PICKS_SOURCE_ID)).toEqual([expect.objectContaining({
      url: 'https://marketplace.happier.dev/catalog.json', format: 'happier-catalog',
      enabled: false, origin: { kind: 'built_in' }, removable: false,
    })]);
    expect(sources.find(source => source.id === configuredSource.id)).toMatchObject({ enabled: true, origin: { kind: 'user' }, removable: true });
    expect(listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] })[0])
      .toMatchObject({ id: HAPPIER_PICKS_SOURCE_ID, enabled: true, origin: { kind: 'built_in' }, removable: false });
  });
  it('fails closed when tolerant projection would discard a token reference', () => {
    const source = { id: 'private', title: 'Private', format: 'git', kinds: ['skill'],
      url: 'https://github.com/acme/private', enabled: true, addedAt: 1, token: { secretRef: 'personal-token' } };
    for (const sources of [[{ ...source, futureCredential: { secretRef: 'hidden-token' } }],
      [{ ...source, title: null }], [source, { ...source, token: { secretRef: 'second-token' } }]]) {
      const value = { v: 2, sources, disabledSourceIds: [] };
      expect(openPromptLibraryContentV1({ key: 'registry-sources', mode: 'plain', material: null,
        content: { t: 'plain', v: { key: 'registry-sources', value } } }))
        .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    }
  });
  it.each([null,42,{v:3,sources:[]},{v:2},{sources:[]}])('keeps invalid stored envelope %j unavailable',value=>{
    expect(openPromptLibraryContentV1({key:'registry-sources',mode:'plain',material:null,content:{t:'plain',v:{key:'registry-sources',value}}})).toEqual({status:'unavailable',reason:'invalid-stored-content'});
  });
});

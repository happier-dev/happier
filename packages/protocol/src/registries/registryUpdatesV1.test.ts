import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { checkRegistryUpstreamV1, compareRegistryContentRefV1, registryUpstreamEqualV1, RegistryUpdateCheckResultV1Schema } from './registryUpdatesV1.js';
import { RegistryProvenanceV1Schema, type RegistryContentRefV1 } from './registryItemsV1.js';
import { githubRegistryAdapterV1 } from './formats/github.js';
import type { RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';
import type { RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
import { acpRegistryAdapterV1 } from './formats/acpRegistry.js';
import { ACP_REGISTRY_V1_FIXTURE } from './formats/fixtures/acpRegistryV1Fixture.js';
import { claudeMarketplaceRegistryAdapterV1 } from './formats/claudeMarketplace.js';

const commit = '1'.repeat(40), next = '2'.repeat(40);
const source: RegistrySourceDescriptorV1 = { id: 'repo', title: 'Repo', format: 'git', kinds: ['skill'],
  url: 'https://github.com/a/b', ref: 'release', path: 'skills', token: { secretRef: 'private-token' },
  enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };

function fixture() {
  let head = commit, subtree: string | null = 'subtree';
  const calls: { url: string; sourceId?: string; token?: string }[] = [];
  const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP method'); };
  const http: RegistryHttpV1 = {
    async getJson(url, options) {
      calls.push({ url, sourceId: options?.source?.id, token: options?.source?.token?.secretRef });
      return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: head } : { sha: 'root', tree: subtree ? [
        { path: 'skills/review', type: 'tree', mode: '040000', sha: subtree },
        { path: 'skills/review/SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 1 },
      ] : [] } };
    },
    getText: async () => ({ ok: true, fetchedAt: 1, value: '# Review\n' }), getBytes: unused,
  };
  return { http, calls, move: (sha: string, tree: string | null) => { head = sha; subtree = tree; } };
}
async function imported(http: RegistryHttpV1) {
  const item = await githubRegistryAdapterV1.read({ http }, { source, kind: 'skill', itemId: 'review' });
  return { ...RegistryProvenanceV1Schema.parse({ sourceId: source.id, format: source.format, sourceUrl: source.url,
    itemId: item.summary.itemId, ref: item.payload.skill.ref, importedAt: item.fetchedAt }), ref: item.payload.skill.ref };
}

describe('registry upstream content observations', () => {
  it('admits each selected update source once for all of its upstream reads', async () => {
    const f = fixture();
    const provenance = await imported(f.http);
    f.move(next, 'next-tree');
    f.calls.length = 0;
    const admitted: string[] = [];
    const forbidden = async (): Promise<never> => { throw new Error('Unadmitted upstream transport'); };
    const result = await checkRegistryUpstreamV1({ http: { getJson: forbidden, getText: forbidden, getBytes: forbidden } }, {
      sources: [source], items: [{ key: 'skill', provenance }],
      admitSource: async selected => { admitted.push(selected.id); return { http: f.http }; },
    });
    expect(result.get('skill')).toMatchObject({ state: 'update_available', latest: { commit: next } });
    expect(admitted).toEqual([source.id]);
    expect(f.calls).toHaveLength(2);
  });

  it('projects the strict unchecked result for schema consumers without admitting a successful source reason', () => {
    expect(() => z.toJSONSchema(RegistryUpdateCheckResultV1Schema)).not.toThrow();
    const result = { checkedAt: 1, results: [{ kind: 'skill', key: 'item', upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } }] };
    expect(RegistryUpdateCheckResultV1Schema.parse(result)).toEqual(result);
    expect(RegistryUpdateCheckResultV1Schema.safeParse({ ...result, results: [{ ...result.results[0],
      upstream: { state: 'unchecked', reason: { state: 'ok', fetchedAt: 1 } } }] }).success).toBe(false);
  });

  it('compares content identity and registry version strings without guessing semver ordering', () => {
    const current: RegistryContentRefV1 = { kind: 'gitTree', repo: source.url, path: 'skills/review', commit, treeSha: 'subtree' };
    expect(compareRegistryContentRefV1(current, { ...current, commit: next })).toBe('current');
    expect(compareRegistryContentRefV1(current, { ...current, treeSha: 'changed' })).toBe('update_available');
    expect(compareRegistryContentRefV1(current, 'removed')).toBe('removed_from_source');
    expect(compareRegistryContentRefV1({ kind: 'version', version: '2026.10' }, { kind: 'version', version: '2026.9' })).toBe('update_available');
    expect(compareRegistryContentRefV1({ kind: 'version', version: 'v1' }, { kind: 'version', version: 'v1' })).toBe('current');
    expect(registryUpstreamEqualV1({ state: 'current', latest: current }, { latest: { ...current }, state: 'current' })).toBe(true);
    expect(registryUpstreamEqualV1({ state: 'current', latest: current }, { state: 'current', latest: { ...current, commit: next } })).toBe(false);
    expect(registryUpstreamEqualV1(undefined, { state: 'current' })).toBe(false);
  });

  it('checks the configured branch once and skips the tree when the imported commit is still current', async () => {
    const f = fixture(), provenance = await imported(f.http); f.calls.length = 0;
    const result = await checkRegistryUpstreamV1({ http: f.http }, { sources: [source], items: [
      { key: 'first', provenance }, { key: 'second', provenance },
    ] });
    expect(result.get('first')).toEqual({ state: 'current', latest: provenance.ref });
    expect(result.get('second')).toEqual(result.get('first'));
    expect(f.calls).toEqual([{ url: 'https://api.github.com/repos/a/b/commits/release', sourceId: source.id, token: 'private-token' }]);
  });

  it('compares the imported subtree on a changed commit, and treats a missing SKILL.md as removal', async () => {
    const f = fixture(), provenance = await imported(f.http);
    const check = () => checkRegistryUpstreamV1({ http: f.http }, { sources: [source], items: [{ key: 'item', provenance }] });
    f.move(next, 'subtree');
    expect((await check()).get('item')).toMatchObject({ state: 'current', latest: { commit: next, treeSha: 'subtree' } });
    f.move(next, 'changed');
    expect((await check()).get('item')).toMatchObject({ state: 'update_available', latest: { treeSha: 'changed' } });
    f.move(next, null);
    expect((await check()).get('item')).toEqual({ state: 'removed_from_source' });
    const withoutSkill: RegistryHttpV1 = { ...f.http, getJson: async url => ({ ok: true, fetchedAt: 2,
      value: url.includes('/commits/') ? { sha: next } : { sha: 'root', tree: [{ path: 'skills/review', type: 'tree', mode: '040000', sha: 'changed' }] } }) };
    expect((await checkRegistryUpstreamV1({ http: withoutSkill }, { sources: [source], items: [{ key: 'item', provenance }] })).get('item'))
      .toEqual({ state: 'removed_from_source' });
  });

  it('keeps a failed or disabled source unchecked while another source succeeds', async () => {
    const f = fixture(), provenance = await imported(f.http);
    const healthy = { ...source, id: 'healthy', url: 'https://github.com/a/healthy' };
    const rateLimited: RegistryHttpV1 = { ...f.http, getJson: async (url, opts) => url.includes('/a/b/')
      ? { ok: false, status: { state: 'rate_limited', retryAt: 1000 } } : f.http.getJson(url, opts) };
    const result = await checkRegistryUpstreamV1({ http: rateLimited }, { sources: [source, healthy], items: [
      { key: 'limited', provenance }, { key: 'healthy', provenance: { ...provenance, sourceId: healthy.id, sourceUrl: healthy.url,
        ref: { ...provenance.ref, repo: healthy.url } } },
    ] });
    expect(result.get('limited')).toEqual({ state: 'unchecked', reason: { state: 'rate_limited', retryAt: 1000 } });
    expect(result.get('healthy')).toMatchObject({ state: 'current' });
    expect((await checkRegistryUpstreamV1({ http: f.http }, { sources: [{ ...source, enabled: false }],
      items: [{ key: 'disabled', provenance }] })).get('disabled')).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
  });

  it('does not convert cancellation into an unchecked result', async () => {
    const f = fixture(), provenance = await imported(f.http), controller = new AbortController();
    const reason = new TypeError('Account retired');
    const cancelled: RegistryHttpV1 = { ...f.http, getJson: async () => { controller.abort(reason); throw reason; } };
    await expect(checkRegistryUpstreamV1({ http: cancelled, signal: controller.signal }, {
      sources: [source], items: [{ key: 'item', provenance }],
    })).rejects.toBe(reason);
  });

  it('batches an ACP index with its source credential binding and treats only absent ids as removed', async () => {
    const acp: RegistrySourceDescriptorV1 = { ...source, id: 'private-acp', format: 'acp-registry', kinds: ['agent'],
      url: 'https://acp.example/registry.json' };
    const requests: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP request'); };
    const http: RegistryHttpV1 = { getJson: async (url, opts) => {
      requests.push(url); expect(opts?.source?.token).toEqual(acp.token);
      return { ok: true, fetchedAt: 1, value: ACP_REGISTRY_V1_FIXTURE };
    }, getText: unused, getBytes: unused };
    const item = await acpRegistryAdapterV1.read({ http }, { source: acp, kind: 'agent', itemId: 'goose' });
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: acp.id, sourceUrl: acp.url, format: acp.format,
      itemId: 'goose', ref: { kind: 'version', version: item.summary.version }, importedAt: item.fetchedAt });
    requests.length = 0;
    const result = await checkRegistryUpstreamV1({ http }, { sources: [acp], items: [
      { key: 'goose', provenance }, { key: 'gone', provenance: { ...provenance, itemId: 'gone' } },
    ] });
    expect(result.get('goose')).toEqual({ state: 'current', latest: provenance.ref });
    expect(result.get('gone')).toEqual({ state: 'removed_from_source' });
    expect(requests).toEqual([acp.url]);
  });

  it('retains the source branch and token receiver when skills.sh resolves a GitHub repository', async () => {
    const f = fixture(), original = await imported(f.http); f.calls.length = 0;
    const skillsSh: RegistrySourceDescriptorV1 = { ...source, format: 'skills-sh', url: 'https://skills.sh', path: undefined };
    const provenance = { ...original, format: skillsSh.format, sourceUrl: skillsSh.url, itemId: 'a/b/review' };
    expect((await checkRegistryUpstreamV1({ http: f.http }, { sources: [skillsSh], items: [{ key: 'skill', provenance }] })).get('skill'))
      .toMatchObject({ state: 'current' });
    expect(f.calls).toEqual([{ url: 'https://api.github.com/repos/a/b/commits/release', sourceId: source.id, token: 'private-token' }]);
  });

  it('resolves a marketplace plugin branch while retaining the catalog token receiver', async () => {
    const market: RegistrySourceDescriptorV1 = { ...source, url: 'https://github.com/a/catalog', format: 'claude-marketplace', path: undefined, ref: 'catalog-main' };
    const calls: { url: string; credentialUrl?: string }[] = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP request'); };
    const http: RegistryHttpV1 = { getJson: async (url, opts) => {
      calls.push({ url, credentialUrl: opts?.source?.url });
      return { ok: true, fetchedAt: 1, value: url.endsWith('/marketplace.json')
        ? { plugins: [{ name: 'remote', source: { source: 'github', repo: 'a/skills', ref: 'stable' } }] }
        : url.endsWith('/plugin.json') ? {} : url.includes('/commits/') ? { sha: commit }
          : { sha: 'root', tree: [{ path: 'skills/review', type: 'tree', mode: '040000', sha: 'subtree' },
            { path: 'skills/review/SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 1 }] } };
    }, getText: async () => ({ ok: true, fetchedAt: 1, value: '# Review\n' }), getBytes: unused };
    const item = await claudeMarketplaceRegistryAdapterV1.read({ http }, { source: market, kind: 'skill', itemId: 'remote/skills/review' });
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: market.id, sourceUrl: market.url, format: market.format,
      itemId: item.summary.itemId, ref: item.payload.skill.ref, importedAt: item.fetchedAt });
    calls.length = 0;
    expect((await checkRegistryUpstreamV1({ http }, { sources: [market], items: [{ key: 'skill', provenance }] })).get('skill')).toMatchObject({ state: 'current' });
    expect(calls.map(call => call.url)).toEqual(['https://raw.githubusercontent.com/a/catalog/catalog-main/.claude-plugin/marketplace.json',
      'https://api.github.com/repos/a/skills/commits/stable']);
    expect(calls.every(call => call.credentialUrl === market.url)).toBe(true);
  });

  it.each([{ plugins: 'invalid envelope' }, { plugins: [{ name: 'remote' }] }])('keeps malformed marketplace declarations unchecked rather than removed', async body => {
    const f = fixture(), original = await imported(f.http);
    const market: RegistrySourceDescriptorV1 = { ...source, format: 'claude-marketplace', url: 'https://github.com/a/catalog' };
    const provenance = RegistryProvenanceV1Schema.parse({ ...original, sourceUrl: market.url, format: market.format, itemId: 'remote/skills/review' });
    const http: RegistryHttpV1 = { ...f.http, getJson: async () => ({ ok: true, fetchedAt: 1, value: body }) };
    expect((await checkRegistryUpstreamV1({ http }, { sources: [market], items: [{ key: 'skill', provenance }] })).get('skill'))
      .toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
  });
});

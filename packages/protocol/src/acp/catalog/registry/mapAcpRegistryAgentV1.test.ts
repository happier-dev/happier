import { describe, expect, it } from 'vitest';
import { acpRegistryAdapterV1 } from '../../../registries/formats/acpRegistry.js';
import { ACP_REGISTRY_V1_FIXTURE, ACP_REGISTRY_BINARY_ENV_FIXTURE } from '../../../registries/formats/fixtures/acpRegistryV1Fixture.js';
import type { RegistryHttpV1 } from '../../../registries/formats/registryFormatAdapterV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../../../registries/registrySourcesV1.js';
import { AcpBackendDefinitionV1Schema } from '../settingsV1.js';
import { mapAcpRegistryAgentToDefinitionV1 } from './mapAcpRegistryAgentV1.js';
import { resolveAcpPlatformFitV1 } from './acpPlatformFitV1.js';

async function agent(id: string) {
  const source = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.format === 'acp-registry')!;
  const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };
  const http: RegistryHttpV1 = { getJson: async () => ({ ok: true, value: { ...ACP_REGISTRY_V1_FIXTURE, agents: [...ACP_REGISTRY_V1_FIXTURE.agents, ACP_REGISTRY_BINARY_ENV_FIXTURE] }, fetchedAt: 10 }), getText: unused, getBytes: unused };
  const item = await acpRegistryAdapterV1.read({ http }, { source, kind: 'agent', itemId: id });
  if (item.payload.kind !== 'agent') throw new Error('Missing agent');
  return { agent: item.payload.agent, provenance: { sourceId: source.id, format: 'acp-registry' as const, sourceUrl: source.url, itemId: id, ref: { kind: 'version' as const, version: item.summary.version! }, importedAt: 10 }, nowMs: 10 };
}
describe('registry Agent mapping', () => {
  it('maps real producer output into strict definitions with optional digests, paths, env and pinned launches', async () => {
    const goose = mapAcpRegistryAgentToDefinitionV1(await agent('goose'));
    expect(goose).toMatchObject({ ok: true, definition: { origin: { provenance: { itemId: 'goose', ref: { version: '1.54.0' } } }, launch: { kind: 'archive', assetsByPlatform: {
      'linux-x64': { kind: 'archive', executableSubpath: 'goose', args: ['acp'], sha256: 'bf01cb6359f7a2b1acb54ca4827e1d059b18aabb3d2b75202e21066cfd3a3396' },
      'win32-x64': { executableSubpath: 'goose-package/goose.exe' },
    } } } });
    for (const id of ['goose', 'junie', 'claude-acp', 'fast-agent', 'vtcode']) {
      const mapped = mapAcpRegistryAgentToDefinitionV1(await agent(id));
      if (!mapped.ok) throw new Error(`Mapping failed: ${id}`);
      expect(AcpBackendDefinitionV1Schema.safeParse(mapped.definition).success).toBe(true);
    }
    const junie = mapAcpRegistryAgentToDefinitionV1(await agent('junie'));
    expect(junie).toMatchObject({ ok: true, definition: { launch: { assetsByPlatform: { 'linux-x64': { executableSubpath: 'junie-app/bin/junie' } } } } });
    if (!junie.ok || junie.definition.launch.kind !== 'archive') throw new Error('Missing archive');
    expect(junie.definition.launch.assetsByPlatform['linux-x64']).not.toHaveProperty('sha256');
    expect(mapAcpRegistryAgentToDefinitionV1(await agent('fast-agent'))).toMatchObject({ ok: true, definition: { launch: { kind: 'uv', package: 'fast-agent-acp', version: '0.10.1' }, env: { FAST_AGENT_MODEL: { t: 'literal', v: 'codexplan' } } } });
    expect(mapAcpRegistryAgentToDefinitionV1(await agent('vtcode'))).toMatchObject({ ok: true, definition: { launch: { envByPlatform: { 'linux-x64': { VT_ACP_ENABLED: '1', VT_ACP_ZED_ENABLED: '1' } } } } });
  });
  it('chooses npm before binary before uv and keeps user-owned fields on update', async () => {
    const input = await agent('goose');
    const first = mapAcpRegistryAgentToDefinitionV1(input);
    if (!first.ok) throw new Error('Missing definition');
    const existing = AcpBackendDefinitionV1Schema.parse({ ...first.definition, id: 'saved-id', name: 'my-agent', title: 'My Agent', env: { TOKEN: { t: 'savedSecret', secretId: 'personal-token' } }, defaultMode: 'edit', defaultModel: 'chosen' });
    const distributions = { ...input.agent.distributions, npm: { package: 'agent', version: '2.0.0', args: ['acp'], env: { DEFAULT: 'value' } }, uv: { package: 'agent', version: '3.0.0', args: [], env: {} } };
    const updated = mapAcpRegistryAgentToDefinitionV1({ ...input, agent: { ...input.agent, version: '2.0.0', distributions }, provenance: { ...input.provenance, ref: { kind: 'version', version: '2.0.0' } }, existing, nowMs: 20 });
    expect(updated).toMatchObject({ ok: true, definition: { id: 'saved-id', name: 'my-agent', title: 'My Agent', env: existing.env, defaultMode: 'edit', defaultModel: 'chosen', createdAt: 10, updatedAt: 20, launch: { kind: 'npm', package: 'agent', version: '2.0.0' } } });
    expect(resolveAcpPlatformFitV1(distributions, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'can_run', via: 'npm' });
    expect(mapAcpRegistryAgentToDefinitionV1({ ...input, agent: { ...input.agent, distributions: {} } })).toEqual({ ok: false, code: 'no_supported_distribution' });
  });
  it('classifies raw binary URLs once and refuses unsafe executable paths', async () => {
    const input = await agent('goose');
    const asset = { archiveUrl: 'https://example.com/agent?download=.zip', command: './agent', args: ['acp'], env: {} };
    const raw = { ...input, agent: { ...input.agent, distributions: { binary: { 'linux-x64': asset } } } };
    expect(mapAcpRegistryAgentToDefinitionV1(raw)).toMatchObject({ ok: true, definition: { launch: { assetsByPlatform: { 'linux-x64': { kind: 'executable' } } } } });
    expect(resolveAcpPlatformFitV1(raw.agent.distributions, { platform: 'linux', arch: 'x64' })).toMatchObject({ kind: 'can_run', target: 'linux-x64' });
    expect(mapAcpRegistryAgentToDefinitionV1({ ...raw, agent: { ...raw.agent, distributions: { binary: { 'linux-x64': { ...asset, command: '../agent' } } } } })).toEqual({ ok: false, code: 'no_supported_distribution' });
    const bzip = { ...raw, agent: { ...raw.agent, distributions: { binary: { 'linux-x64': { ...asset, archiveUrl: 'https://example.com/agent.tbz2' } } } } };
    expect(mapAcpRegistryAgentToDefinitionV1(bzip)).toMatchObject({ ok: true, definition: { launch: { assetsByPlatform: { 'linux-x64': { kind: 'archive' } } } } });
    expect(resolveAcpPlatformFitV1(bzip.agent.distributions, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'can_run', via: 'archive', target: 'linux-x64' });
  });
  it('refuses inconsistent provenance instead of producing a false registry pin', async () => {
    const input = await agent('goose');
    for (const provenance of [
      { ...input.provenance, itemId: 'different-agent' },
      { ...input.provenance, format: 'happier-catalog' as const },
      { ...input.provenance, ref: { kind: 'version' as const, version: '1.0.0' } },
      { ...input.provenance, ref: { kind: 'gitTree' as const, repo: 'https://github.com/a/b', path: '', commit: 'commit', treeSha: 'tree' } },
    ]) expect(mapAcpRegistryAgentToDefinitionV1({ ...input, provenance })).toEqual({ ok: false, code: 'no_supported_distribution' });
  });
});

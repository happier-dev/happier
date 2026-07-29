import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createPluginContributionIdentity } from '@happier-dev/protocol';

import type { ResolvedPromptAssetContribution, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import { createStablePluginResourcesOwner } from '@/plugins/runtime/invocation/services/resources';
import { bindPromptAssetContributionBlocks, MAX_PLUGIN_PROMPT_ASSET_BYTES } from './bindPromptAssetContributionBlocks';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function digest(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function createFixture(params: Readonly<{ bytes: Buffer; contentType: string }>) {
  const promptPluginId = 'acme.prompts';
  const resourcePluginId = 'acme.resources';
  const rootPath = await mkdtemp(join(tmpdir(), 'happier-prompt-asset-binding-'));
  roots.push(rootPath);
  await mkdir(join(rootPath, 'resources'));
  await writeFile(join(rootPath, 'resources', 'instructions.txt'), params.bytes);
  const resource: ResolvedResourceContribution = {
    provenance: 'external', source: { kind: 'archive' }, pluginId: resourcePluginId, pluginRootPath: rootPath,
    manifestPath: join(rootPath, '.happier-plugin', 'plugin.json'), manifestDigest: digest('resource-manifest'),
    daemonEntryPath: null,
    sourceSpec: { kind: 'archive', locator: 'resources.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
    definition: {
      kindVersion: 1, id: 'instructions', type: 'prompt', path: 'resources/instructions.txt',
      digest: digest(params.bytes), contentType: params.contentType,
    },
  };
  const owner = await createStablePluginResourcesOwner({
    registry: { generationId: 'registry:current', resources: [resource] },
    generations: new Map([
      [promptPluginId, { pluginId: promptPluginId, immutableGenerationId: 'prompts-1', rootPath: '/unused', files: [] }],
      [resourcePluginId, {
        pluginId: resourcePluginId, immutableGenerationId: 'resources-1', rootPath,
        files: [{ relativePath: 'resources/instructions.txt', byteLength: params.bytes.byteLength, digest: digest(params.bytes) }],
      }],
    ]),
  });
  const promptAsset: ResolvedPromptAssetContribution = {
    provenance: 'external', source: { kind: 'archive' }, pluginId: promptPluginId,
    identity: createPluginContributionIdentity({ pluginId: promptPluginId, localId: 'review' }),
    manifestPath: '/plugins/acme.prompts/.happier-plugin/plugin.json', manifestDigest: digest('prompt-manifest'),
    daemonEntryPath: null,
    sourceSpec: { kind: 'archive', locator: 'prompts.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
    definition: {
      id: 'review', kind: 'guidelines',
      resource: { pluginId: resourcePluginId, localId: 'instructions' },
      target: { kind: 'agent', agent: { pluginId: 'acme.agent', localId: 'worker' } },
      availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
    },
  };
  return { owner, promptAsset };
}

describe('prompt asset production binding', () => {
  it('uses structured cross-plugin identity and exact SVC11 text once policy allows it', async () => {
    const { owner, promptAsset } = await createFixture({ bytes: Buffer.from('\nExact instructions\n'), contentType: 'text/markdown' });
    await expect(bindPromptAssetContributionBlocks({
      registry: { generationId: 'registry:current', promptAssets: [promptAsset] },
      resources: owner, agent: { pluginId: 'acme.agent', localId: 'worker' },
      signal: new AbortController().signal, isGenerationCurrent: () => true,
      facts: { 'plugin.enabled': true },
    })).resolves.toEqual([{
      id: 'plugin_prompt_asset.acme.prompts/review', scope: 'provider_behavior', text: '\nExact instructions\n',
    }]);
  });

  it('fails closed for non-text and oversized prompt resources', async () => {
    const binary = await createFixture({ bytes: Buffer.from([0xff]), contentType: 'application/octet-stream' });
    await expect(bindPromptAssetContributionBlocks({
      registry: { generationId: 'registry:current', promptAssets: [binary.promptAsset] }, resources: binary.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' }, signal: new AbortController().signal,
      isGenerationCurrent: () => true, facts: { 'plugin.enabled': true },
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID' });

    const oversized = await createFixture({ bytes: Buffer.alloc(MAX_PLUGIN_PROMPT_ASSET_BYTES + 1, 'x'), contentType: 'text/plain' });
    await expect(bindPromptAssetContributionBlocks({
      registry: { generationId: 'registry:current', promptAssets: [oversized.promptAsset] }, resources: oversized.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' }, signal: new AbortController().signal,
      isGenerationCurrent: () => true, facts: { 'plugin.enabled': true },
    })).rejects.toMatchObject({ code: 'plugin_resource_too_large' });
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createPluginContributionIdentity } from '@happier-dev/protocol';

import type { ResolvedPromptAssetContribution, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import { createStablePluginResourcesOwner } from '@/plugins/runtime/invocation/services/resources';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { bindPromptAssetContributionBlocks, MAX_PLUGIN_PROMPT_ASSET_BYTES } from './bindPromptAssetContributionBlocks';
import type { OptionalPromptAssetUnavailable } from './resolvePromptAssetContributionBlocks';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function digest(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function createFixture(params: Readonly<{ bytes: Buffer; contentType: string; withSecondary?: boolean; demandLoaded?: boolean }>) {
  const promptPluginId = 'acme.prompts';
  const resourcePluginId = 'acme.resources';
  const rootPath = await mkdtemp(join(tmpdir(), 'happier-prompt-asset-binding-'));
  roots.push(rootPath);
  await mkdir(join(rootPath, 'resources'));
  await writeFile(join(rootPath, 'resources', 'instructions.txt'), params.bytes);
  const secondaryBytes = Buffer.from('Secondary instructions');
  if (params.withSecondary) await writeFile(join(rootPath, 'resources', 'secondary.txt'), secondaryBytes);
  const resource: ResolvedResourceContribution = {
    provenance: 'external', source: { kind: 'archive' }, pluginId: resourcePluginId, pluginRootPath: rootPath,
    manifestPath: join(rootPath, '.happier-plugin', 'plugin.json'), daemonEntryPath: null,
    sourceSpec: { kind: 'archive', locator: 'resources.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
    definition: {
      kindVersion: 1, id: 'instructions', type: 'prompt', path: 'resources/instructions.txt',
      digest: digest(params.bytes), contentType: params.contentType,
    },
  };
  const occurrenceIdsByPluginId = new Map([
    [promptPluginId, createPluginRuntimeOccurrenceId(promptPluginId)],
    [resourcePluginId, createPluginRuntimeOccurrenceId(resourcePluginId)],
  ]);
  const owner = await createStablePluginResourcesOwner({
    registry: { resources: [resource, ...(params.withSecondary ? [{ ...resource, definition: {
      ...resource.definition, id: 'secondary', path: 'resources/secondary.txt', digest: digest(secondaryBytes),
    } }] : [])] },
    generations: new Map([
      [promptPluginId, { pluginId: promptPluginId, immutableGenerationId: 'prompts-1', rootPath: '/unused', files: [] }],
      [resourcePluginId, {
        pluginId: resourcePluginId, immutableGenerationId: 'resources-1', rootPath,
        files: params.demandLoaded ? null : [{ relativePath: 'resources/instructions.txt', byteLength: params.bytes.byteLength, digest: digest(params.bytes) },
          ...(params.withSecondary ? [{ relativePath: 'resources/secondary.txt', byteLength: secondaryBytes.byteLength, digest: digest(secondaryBytes) }] : [])],
      }],
    ]),
  });
  const promptAsset: ResolvedPromptAssetContribution = {
    provenance: 'external', source: { kind: 'archive' }, pluginId: promptPluginId,
    identity: createPluginContributionIdentity({ pluginId: promptPluginId, localId: 'review' }),
    manifestPath: '/plugins/acme.prompts/.happier-plugin/plugin.json', daemonEntryPath: null,
    sourceSpec: { kind: 'archive', locator: 'prompts.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
    definition: {
      id: 'review', kind: 'guidelines',
      resource: { pluginId: resourcePluginId, localId: 'instructions' },
      target: { kind: 'agent', agent: { pluginId: 'acme.agent', localId: 'worker' } },
      availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
    },
  };
  return { owner, promptAsset, occurrenceIdsByPluginId, rootPath };
}

describe('prompt asset production binding', () => {
  it.each([false, true])('uses exact allowed cross-plugin prompt text with demand-loaded bytes %s', async (demandLoaded) => {
    const { owner, promptAsset, occurrenceIdsByPluginId } = await createFixture({ bytes: Buffer.from('\nExact instructions\n'), contentType: 'text/markdown', demandLoaded });
    await expect(bindPromptAssetContributionBlocks({
      promptAssets: [promptAsset],
      resolveContributionOccurrence: (pluginId) => occurrenceIdsByPluginId.get(pluginId) ?? null,
      isContributionOccurrenceCurrent: (pluginId, occurrenceId) => occurrenceIdsByPluginId.get(pluginId) === occurrenceId,
      resources: owner, agent: { pluginId: 'acme.agent', localId: 'worker' },
      signal: new AbortController().signal, isOccurrenceCurrent: () => true,
      facts: { 'plugin.enabled': true },
    })).resolves.toEqual([{
      id: 'plugin_prompt_asset.acme.prompts/review', scope: 'provider_behavior', text: '\nExact instructions\n',
    }]);
  });

  it('fails closed for non-text, oversized and integrity-invalid prompt resources', async () => {
    const binary = await createFixture({ bytes: Buffer.from([0xff]), contentType: 'application/octet-stream' });
    await expect(bindPromptAssetContributionBlocks({
      promptAssets: [binary.promptAsset],
      resolveContributionOccurrence: (pluginId) => binary.occurrenceIdsByPluginId.get(pluginId) ?? null,
      isContributionOccurrenceCurrent: (pluginId, occurrenceId) => binary.occurrenceIdsByPluginId.get(pluginId) === occurrenceId,
      resources: binary.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' }, signal: new AbortController().signal,
      isOccurrenceCurrent: () => true, facts: { 'plugin.enabled': true },
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID' });

    const oversized = await createFixture({ bytes: Buffer.alloc(MAX_PLUGIN_PROMPT_ASSET_BYTES + 1, 'x'), contentType: 'text/plain' });
    await expect(bindPromptAssetContributionBlocks({
      promptAssets: [oversized.promptAsset],
      resolveContributionOccurrence: (pluginId) => oversized.occurrenceIdsByPluginId.get(pluginId) ?? null,
      isContributionOccurrenceCurrent: (pluginId, occurrenceId) => oversized.occurrenceIdsByPluginId.get(pluginId) === occurrenceId,
      resources: oversized.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' }, signal: new AbortController().signal,
      isOccurrenceCurrent: () => true, facts: { 'plugin.enabled': true },
    })).rejects.toMatchObject({ code: 'plugin_resource_too_large' });

    const altered = await createFixture({ bytes: Buffer.from('Trusted instructions'), contentType: 'text/plain' });
    await writeFile(join(altered.rootPath, 'resources', 'instructions.txt'), Buffer.from('Altered instructions'));
    await expect(bindPromptAssetContributionBlocks({
      promptAssets: [altered.promptAsset],
      resolveContributionOccurrence: (pluginId) => altered.occurrenceIdsByPluginId.get(pluginId) ?? null,
      isContributionOccurrenceCurrent: (pluginId, occurrenceId) => altered.occurrenceIdsByPluginId.get(pluginId) === occurrenceId,
      resources: altered.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' }, signal: new AbortController().signal,
      isOccurrenceCurrent: () => true, facts: { 'plugin.enabled': true },
    })).rejects.toMatchObject({ code: 'plugin_resource_integrity_mismatch' });
  });

  it('omits unavailable automatic augmentation while retaining a usable asset and required selection failure', async () => {
    const fixture = await createFixture({ bytes: Buffer.from('Available instructions'), contentType: 'text/plain', withSecondary: true });
    const unavailableAsset: ResolvedPromptAssetContribution = {
      ...fixture.promptAsset,
      identity: createPluginContributionIdentity({ pluginId: 'acme.prompts', localId: 'unavailable' }),
      definition: { ...fixture.promptAsset.definition, id: 'unavailable', resource: { pluginId: 'acme.resources', localId: 'secondary' } },
    };
    // Declaration and immutable-generation admission both succeeded. Lose only
    // the declared bytes at the real filesystem boundary before preparation.
    await unlink(join(fixture.rootPath, 'resources', 'secondary.txt'));
    const omitted: OptionalPromptAssetUnavailable[] = [];
    const input = {
      onOptionalUnavailable: (fact: OptionalPromptAssetUnavailable) => { omitted.push(fact); },
      promptAssets: [unavailableAsset, fixture.promptAsset],
      resolveContributionOccurrence: (pluginId: string) => fixture.occurrenceIdsByPluginId.get(pluginId) ?? null,
      isContributionOccurrenceCurrent: (pluginId: string, occurrenceId: ReturnType<typeof createPluginRuntimeOccurrenceId>) => fixture.occurrenceIdsByPluginId.get(pluginId) === occurrenceId,
      resources: fixture.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      signal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      facts: { 'plugin.enabled': true },
    };
    await expect(bindPromptAssetContributionBlocks(input)).resolves.toEqual([{
      id: 'plugin_prompt_asset.acme.prompts/review', scope: 'provider_behavior', text: 'Available instructions',
    }]);
    await expect(bindPromptAssetContributionBlocks({ ...input,
      selectedAsset: { pluginId: 'acme.prompts', localId: 'unavailable' },
    })).rejects.toMatchObject({ code: 'plugin_resource_missing' });
    expect(omitted).toEqual([{ status: 'unavailable', reason: 'resource_unavailable' }]);
  });

  it('preserves cancellation before unavailable automatic policy can be omitted', async () => {
    const fixture = await createFixture({ bytes: Buffer.from('Instructions'), contentType: 'text/plain' });
    const controller = new AbortController();
    const cancellation = new Error('Preparation cancelled');
    controller.abort(cancellation);
    await expect(bindPromptAssetContributionBlocks({
      promptAssets: [fixture.promptAsset],
      resolveContributionOccurrence: (pluginId) => fixture.occurrenceIdsByPluginId.get(pluginId) ?? null,
      isContributionOccurrenceCurrent: (pluginId, occurrenceId) => fixture.occurrenceIdsByPluginId.get(pluginId) === occurrenceId,
      resources: fixture.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' }, signal: controller.signal,
      isOccurrenceCurrent: () => true, facts: {},
    })).rejects.toBe(cancellation);
  });

  it('rejects a prompt asset whose projected plugin occurrence has retired', async () => {
    const fixture = await createFixture({ bytes: Buffer.from('Current instructions'), contentType: 'text/plain' });
    const projectedOccurrenceId = fixture.occurrenceIdsByPluginId.get('acme.prompts')!;

    await expect(bindPromptAssetContributionBlocks({
      promptAssets: [fixture.promptAsset],
      resolveContributionOccurrence: () => projectedOccurrenceId,
      isContributionOccurrenceCurrent: () => false,
      resources: fixture.owner,
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      signal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      facts: { 'plugin.enabled': true },
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID' });
  });
});

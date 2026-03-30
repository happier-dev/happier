import { describe, expect, it } from 'vitest';

import { PromptRegistryFetchedItemV1Schema } from '@happier-dev/protocol';

import type { PromptRegistryRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import { reloadConfiguration } from '@/configuration';

describe('resolvePromptRegistryItemDownloadSource', () => {
  it('fails closed when the prompt registry transfer payload exceeds the prompt transfer size limit', async () => {
    const previous = process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
    process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = '32';
    reloadConfiguration();

    try {
      const fetched = PromptRegistryFetchedItemV1Schema.parse({
        sourceId: 'git:local-skills',
        itemId: 'git:local-skills:reviewer',
        title: 'reviewer',
        description: 'Code review helper',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody: {
          v: 1,
          entries: [{ path: 'SKILL.md', contentBase64: 'IyByZXZpZXdlcg==', contentKind: 'utf8' }],
          createdAtMs: 1,
          updatedAtMs: 2,
        },
      });

      const registry: PromptRegistryRegistry = {
        async fetchItem() {
          return { ok: true, item: fetched };
        },
      } as unknown as PromptRegistryRegistry;

      const { resolvePromptRegistryItemDownloadSource } = await import('./resolvePromptRegistryItemDownloadSource');
      const result = await resolvePromptRegistryItemDownloadSource({
        registry,
        request: {
          sourceId: fetched.sourceId,
          itemId: fetched.itemId,
          configuredSources: [],
        },
      });

      expect(result).toEqual({
        success: false,
        error: 'Prompt transfer payload exceeds size limit',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
      } else {
        process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = previous;
      }
      reloadConfiguration();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST } from '../manifest.js';
import {
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID,
  createGithubAutomationEventCheckpointRowId,
  createGithubAutomationEventCheckpointRowV1,
  isGithubAutomationEventCheckpointRowV1,
} from './githubAutomationEventCheckpoint.js';

describe('GitHub Automation Event checkpoint identity', () => {
  // Two pinned vectors over the same encoder. The first is the historical
  // `happier.scm.hosting.github` identity and still hashes to its established
  // value, so a change to the length-delimited encoding or the domain constant
  // fails here rather than silently rekeying every checkpoint row; the second
  // pins the current forge identity the plugin actually emits.
  it.each([
    ['happier.scm.hosting.github', '5EStHbj8sHB6-koXZwHi8DyaWxkafxgBmQQ1KtW-oEo'],
    ['happier.scm.forge.github', '1qG7cjvTIW4qmiqAYEnbVsAMm4IdMyxlA7emUoyTQb0'],
  ])('preserves the established canonical domain-separated opaque row ID for %s', (
    pluginId,
    rowId,
  ) => {
    expect(createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      eventRef: {
        pluginId,
        localId: 'automation/repository-event-v1',
      },
      sourceSelectorId: '00000000-0000-4000-8000-000000000001',
    })).toBe(rowId);
  });

  it('produces rows accepted by the compiled declared checkpoint collection schema', () => {
    const row = createGithubAutomationEventCheckpointRowV1({
      automationId: 'automation-a',
      sourceSelectorId: '00000000-0000-4000-8000-000000000001',
      sourceInstanceId: 'github:repository:77',
      sourceContractVersion: 1,
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['old'],
        etag: 'initial',
      },
      lastContiguousOccurrenceId: null,
      baseline: { kind: 'currentHead', establishedAt: 1_000 },
      lastEvaluatedTemplateVersion: 1,
      continuity: { v: 1, endpointKind: 'repositoryEvents', repositoryId: '77' },
    });
    const validate = compilePluginJsonSchema(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.schema);

    expect(isGithubAutomationEventCheckpointRowV1(row)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, row)).toBe(true);
  });

  it('declares the exact Automation/Event/source lookup within the Collection index ceiling', () => {
    expect(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.indexes).toEqual([{
      id: GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID.byAutomationEventSource,
      fields: [
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId, direction: 'asc' },
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId, direction: 'asc' },
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId, direction: 'asc' },
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId, direction: 'asc' },
      ],
    }]);
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
  });
});

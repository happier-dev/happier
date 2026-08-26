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
  const checkpointRowId = (pluginId: string, localId = 'automation/repository-pushed-v1'): string =>
    createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      eventRef: {
        pluginId,
        localId,
      },
      sourceSelectorId: '00000000-0000-4000-8000-000000000001',
    });

  // One pinned vector, over the identity the plugin actually emits: a change to
  // the length-delimited encoding or the domain constant fails here rather than
  // silently rekeying every checkpoint row. The predecessor `happier.scm.*`
  // spelling is deliberately not pinned. The forge cut was pre-publication, and
  // `isGithubAutomationEventCheckpointRowV1` rejects any row whose
  // `eventPluginId` is not the current `GITHUB_PLUGIN_ID`, so no stored row can
  // address the retired identity and a vector for it would only keep a retired
  // product identity alive in shipped source.
  it('scopes the opaque row ID to each semantic trigger Event', () => {
    const ids = [
      'automation/repository-pushed-v1',
      'automation/issue-opened-v1',
      'automation/pull-request-opened-v1',
      'automation/pull-request-merged-v1',
    ].map((localId) => checkpointRowId('happier.scm.forge.github', localId));

    expect(new Set(ids)).toHaveSize(4);
  });

  // The encoder is domain-separated by the contributing plugin identity, so an
  // encoder that dropped `eventRef.pluginId` would collide two plugins'
  // checkpoints onto one row. Asserted as a property, which needs no second
  // pinned digest and therefore no second product identity in this file.
  it('domain-separates the row ID by contributing plugin identity', () => {
    expect(checkpointRowId('happier.scm.forge.github'))
      .not.toBe(checkpointRowId('happier.scm.forge.gitlab'));
  });

  it('produces rows accepted by the compiled declared checkpoint collection schema', () => {
    const validate = compilePluginJsonSchema(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.schema);
    for (const localId of [
      'automation/repository-pushed-v1',
      'automation/issue-opened-v1',
      'automation/pull-request-opened-v1',
      'automation/pull-request-merged-v1',
    ]) {
      const row = createGithubAutomationEventCheckpointRowV1({
        automationId: 'automation-a',
        eventRef: { pluginId: 'happier.scm.forge.github', localId },
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

      expect(row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]).toBe(localId);
      expect(isGithubAutomationEventCheckpointRowV1(row)).toBe(true);
      expect(isValidPluginJsonSchemaValue(validate, row)).toBe(true);
    }
    const genericRow = {
      ...createGithubAutomationEventCheckpointRowV1({
        automationId: 'automation-a',
        eventRef: {
          pluginId: 'happier.scm.forge.github',
          localId: 'automation/repository-pushed-v1',
        },
        sourceSelectorId: '00000000-0000-4000-8000-000000000001',
        sourceInstanceId: 'github:repository:77',
        sourceContractVersion: 1,
        cursor: null,
        lastContiguousOccurrenceId: null,
        baseline: { kind: 'currentHead', establishedAt: 1_000 },
        lastEvaluatedTemplateVersion: 1,
        continuity: null,
      }),
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: 'automation/repository-event-v1',
    };
    expect(isGithubAutomationEventCheckpointRowV1(genericRow)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, genericRow)).toBe(false);
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

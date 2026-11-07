import { describe, expect, it } from 'vitest';
import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST, collectionMigrations } from '../manifest.js';
import { collectionMigrations as portableMigrations } from '../collectionMigrationArtifact.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID,
  createGithubAutomationEventCheckpointRowId,
  createGithubAutomationEventCheckpointRowV1,
  isGithubAutomationEventCheckpointRowV1,
} from './githubAutomationEventCheckpoint.js';

describe('GitHub Automation Event checkpoint identity', () => {
  const checkpointRowId = (input: Readonly<{
    automationId?: string;
    triggerId?: string;
    eventLocalId?: string;
    sourceSelectorId?: string;
  }> = {}): string =>
    createGithubAutomationEventCheckpointRowId({
      automationId: input.automationId ?? 'automation-a',
      triggerId: input.triggerId ?? 'trigger-a',
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: input.eventLocalId ?? 'automation/repository-pushed-v1',
      },
      sourceSelectorId: input.sourceSelectorId ?? '00000000-0000-4000-8000-000000000001',
    });

  it('keeps semantic trigger checkpoints independently addressable', () => {
    const ids = [
      'automation/repository-pushed-v1',
      'automation/issue-opened-v1',
      'automation/pull-request-opened-v1',
      'automation/pull-request-merged-v1',
    ].map((eventLocalId, index) => checkpointRowId({
      automationId: `automation-${index}`,
      triggerId: `trigger-${index}`,
      eventLocalId,
      sourceSelectorId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    }));

    expect(new Set(ids).size).toBe(4);
  });

  it('domain-separates every trigger-scoped identity fact', () => {
    expect(checkpointRowId({ automationId: 'automation-a' }))
      .not.toBe(checkpointRowId({ automationId: 'automation-b' }));
    expect(checkpointRowId({ triggerId: 'trigger-a' }))
      .not.toBe(checkpointRowId({ triggerId: 'trigger-b' }));
    expect(checkpointRowId({ eventLocalId: 'automation/repository-pushed-v1' }))
      .not.toBe(checkpointRowId({ eventLocalId: 'automation/issue-opened-v1' }));
    expect(checkpointRowId({ sourceSelectorId: '00000000-0000-4000-8000-000000000001' }))
      .not.toBe(checkpointRowId({ sourceSelectorId: '00000000-0000-4000-8000-000000000002' }));
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
        checkpointRowId: checkpointRowId({ eventLocalId: localId }),
        automationId: 'automation-a',
        triggerId: 'trigger-a',
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
        lastEvaluatedTriggerRevision: 1,
        continuity: { v: 1, endpointKind: 'repositoryEvents', repositoryId: '77' },
      });

      expect(row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]).toBe(localId);
      expect(isGithubAutomationEventCheckpointRowV1(row)).toBe(true);
      expect(isValidPluginJsonSchemaValue(validate, row)).toBe(true);
      expect(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.schemaVersion).toBe(2);
      expect(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.readableSchemaVersions).toEqual([1]);
      const migration = collectionMigrations[GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.id]?.[0];
      expect(migration).toMatchObject({ fromSchemaVersion: 1, toSchemaVersion: 2 });
      expect(migration?.migrate(row, { currentRevision: 1 })).toEqual(row);
    }
    const genericRow = {
      ...createGithubAutomationEventCheckpointRowV1({
        checkpointRowId: checkpointRowId({ eventLocalId: 'automation/repository-pushed-v1' }),
        automationId: 'automation-a',
        triggerId: 'trigger-a',
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
        lastEvaluatedTriggerRevision: 1,
        continuity: null,
      }),
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: 'automation/repository-pushed-v0',
    };
    expect(isGithubAutomationEventCheckpointRowV1(genericRow)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, genericRow)).toBe(false);
  });

  it('persists the first baseline of a fresh trigger at Protocol trigger revision zero', () => {
    const validate = compilePluginJsonSchema(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.schema);
    // The canonical trigger create writers mint revision 0 and edits increment
    // from there, so a source's very first checkpoint must be persistable at
    // exactly the revision its admitted definition carries.
    for (const lastEvaluatedTriggerRevision of [0, 1]) {
      const row = createGithubAutomationEventCheckpointRowV1({
        checkpointRowId: checkpointRowId({}),
        automationId: 'automation-a',
        triggerId: 'trigger-a',
        eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
        sourceSelectorId: '00000000-0000-4000-8000-000000000001',
        sourceInstanceId: 'github:repository:77',
        sourceContractVersion: 1,
        cursor: null,
        lastContiguousOccurrenceId: null,
        baseline: { kind: 'currentHead', establishedAt: 1_000 },
        lastEvaluatedTriggerRevision,
        continuity: { v: 1, endpointKind: 'repositoryEvents', repositoryId: '77' },
      });

      expect(isGithubAutomationEventCheckpointRowV1(row)).toBe(true);
      expect(isValidPluginJsonSchemaValue(validate, row)).toBe(true);
      expect(row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload].lastEvaluatedTriggerRevision)
        .toBe(lastEvaluatedTriggerRevision);
    }
  });

  it('declares the trigger/Event/source lookup within the Collection index ceiling', () => {
    expect(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.indexes).toEqual([{
      id: GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID.byAutomationEventSource,
      fields: [
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId, direction: 'asc' },
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId, direction: 'asc' },
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId, direction: 'asc' },
        { field: GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId, direction: 'asc' },
      ],
    }]);
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
    const portable = portableMigrations();
    // The authored entry supplies callbacks; the build embeds this manifest.
    // Real compiled-payload validation lives in collectionMigrationArtifact.test.
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error('Expected the canonical migration manifest to parse');
    const projection: Readonly<Record<string, readonly PluginAccountCollectionMigration[]>> = portable;
    for (const declaration of parsed.manifest.contributes.accountCollections) {
      expect(projection[declaration.id]?.map(({ migrate: _migrate, ...metadata }) => metadata)).toEqual(declaration.migrations);
      for (const migration of projection[declaration.id] ?? []) expect(migration.migrate).toBeTypeOf('function');
    }
    expect(projection[GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.id]?.[0])
      .toMatchObject({ fromSchemaVersion: 1, toSchemaVersion: 2, migrate: expect.any(Function) });
  });
});

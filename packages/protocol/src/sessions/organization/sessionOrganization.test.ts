import { describe, expect, it } from 'vitest';

import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';
import {
  CreateOrUpdateSessionOrganizationFolderRequestSchema,
  CreateOrUpdateSessionOrganizationTagRequestSchema,
  DeleteSessionOrganizationFolderRequestSchema,
  DeleteSessionOrganizationLabelRequestSchema,
  DeleteSessionOrganizationTagRequestSchema,
  ImportLegacySessionOrganizationRequestSchema,
  ReorderSessionOrganizationRequestSchema,
  SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT,
  SESSION_ORGANIZATION_LABEL_KINDS,
  SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES,
  SESSION_ORGANIZATION_ORDER_SCOPE_KINDS,
  SESSION_ORGANIZATION_SNAPSHOT_VERSION,
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
  SessionOrganizationAccountEncryptionMigrationInventorySchema,
  SessionOrganizationFolderSchema,
  SessionOrganizationLabelSchema,
  SessionAttentionStandingSchema,
  SessionOrganizationSnapshotRequestSchema,
  SessionOrganizationSnapshotResponseSchema,
  SessionOrganizationTagSchema,
  SetSessionAttentionStandingRequestSchema,
  SetSessionAttentionStandingResponseSchema,
  SetSessionFolderAssignmentRequestSchema,
  SetSessionPinRequestSchema,
  SetSessionTagAssignmentsRequestSchema,
  UpsertSessionOrganizationLabelRequestSchema,
} from './index.js';

describe('session organization protocol contracts', () => {
  it('uses the canonical stored JSON content envelope for private display content', () => {
    expect(SessionOrganizationContentEnvelopeSchema.parse({ t: 'plain', v: { name: 'Work' } }))
      .toEqual(StoredJsonContentEnvelopeSchema.parse({ t: 'plain', v: { name: 'Work' } }));

    expect(
      SessionOrganizationFolderSchema.parse({
        folderId: 'folder_1',
        folderKey: 'legacy/folder/1',
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: 'a',
        display: { t: 'plain', v: { name: 'Work' } },
        archivedAt: null,
        createdAt: 1,
        updatedAt: 2,
      }).display,
    ).toEqual({ t: 'plain', v: { name: 'Work' } });

    expect(
      SessionOrganizationTagSchema.parse({
        tagId: 'tag_1',
        tagKey: 'legacy/tag/1',
        sortKey: 'b',
        display: { t: 'encrypted', c: 'ciphertext' },
        archivedAt: null,
        createdAt: 1,
        updatedAt: 2,
      }).display,
    ).toEqual({ t: 'encrypted', c: 'ciphertext' });
  });

  it.each([
    ['missing value', { t: 'plain' }],
    ['undefined', { t: 'plain', v: undefined }],
    ['function', { t: 'plain', v: () => undefined }],
    ['symbol', { t: 'plain', v: Symbol('organization') }],
    ['NaN', { t: 'plain', v: Number.NaN }],
    ['Infinity', { t: 'plain', v: Number.POSITIVE_INFINITY }],
    ['BigInt', { t: 'plain', v: 1n }],
  ])('rejects plain display content with a non-JSON %s', (_label, envelope) => {
    expect(SessionOrganizationContentEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('rejects cyclic plain display content', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(SessionOrganizationContentEnvelopeSchema.safeParse({
      t: 'plain',
      v: value,
    }).success).toBe(false);
  });

  it.each([
    { t: 'plain', v: { name: 'Work' }, extra: 'unexpected' },
    { t: 'encrypted', c: 'ciphertext', extra: 'unexpected' },
  ])('rejects unknown top-level display-envelope fields before normalization', (envelope) => {
    expect(SessionOrganizationContentEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('represents corrupt or mode-mismatched display rows without dropping their structure', () => {
    expect(SessionOrganizationDisplayStateSchema.parse({
      status: 'unavailable',
      reason: 'invalid_stored_display',
    })).toEqual({
      status: 'unavailable',
      reason: 'invalid_stored_display',
    });

    expect(SessionOrganizationFolderSchema.parse({
      folderId: 'folder_locked',
      folderKey: 'private/folder/key',
      parentFolderId: null,
      parentFolderKey: null,
      sortKey: 'a',
      display: null,
      displayState: {
        status: 'unavailable',
        reason: 'storage_mode_mismatch',
      },
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    })).toMatchObject({
      folderId: 'folder_locked',
      display: null,
      displayState: {
        status: 'unavailable',
        reason: 'storage_mode_mismatch',
      },
    });
  });

  it('defines an exact bounded migration inventory including archived display rows', () => {
    expect(SessionOrganizationAccountEncryptionMigrationInventorySchema.parse({
      version: 14,
      folders: [{
        folderId: 'folder-archived',
        display: { t: 'plain', v: { name: 'Archived' } },
      }],
      tags: [{
        tagId: 'tag-archived',
        display: { t: 'encrypted', c: 'ciphertext' },
      }],
      labels: [{
        labelKind: 'workspace',
        scopeKey: 'private/workspace/key',
        display: { t: 'plain', v: { label: 'Project' } },
      }],
    })).toEqual({
      version: 14,
      folders: [{
        folderId: 'folder-archived',
        display: { t: 'plain', v: { name: 'Archived' } },
      }],
      tags: [{
        tagId: 'tag-archived',
        display: { t: 'encrypted', c: 'ciphertext' },
      }],
      labels: [{
        labelKind: 'workspace',
        scopeKey: 'private/workspace/key',
        display: { t: 'plain', v: { label: 'Project' } },
      }],
    });
  });

  it('parses scoped snapshots without requiring all historical assignments', () => {
    const request = SessionOrganizationSnapshotRequestSchema.parse({
      includeFolders: true,
      includeTags: true,
      includeAllFolderAssignments: false,
      includeAllTagAssignments: false,
      assignmentSessionIds: ['session_1'],
      folderIds: ['folder_1'],
      tagIds: ['tag_1'],
      orderScopes: [{ scopeKind: 'folder', scopeKey: 'folder_1' }],
    });

    expect(request.assignmentSessionIds).toEqual(['session_1']);
    expect(request.includeAllFolderAssignments).toBe(false);

    const response = SessionOrganizationSnapshotResponseSchema.parse({
      snapshot: {
        schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
        version: 2,
        pins: [{ sessionId: 'session_1', sortKey: 'pin-a', pinnedAt: 10 }],
        folders: [
          {
            folderId: 'folder_1',
            folderKey: 'legacy/folder/1',
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: 'folder-a',
            display: { t: 'plain', v: { name: 'Inbox' } },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        folderAssignments: [{ sessionId: 'session_1', folderId: 'folder_1' }],
        tags: [
          {
            tagId: 'tag_1',
            tagKey: 'legacy/tag/1',
            sortKey: 'tag-a',
            display: { t: 'plain', v: { label: 'Important', color: 'red' } },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        tagAssignments: [{ sessionId: 'session_1', tagIds: ['tag_1'] }],
        orderEntries: [
          {
            scopeKind: 'folder',
            scopeKey: 'folder_1',
            itemKind: 'session',
            itemKey: 'session_1',
            sortKey: 'item-a',
          },
        ],
        labels: [
          {
            labelKind: 'workspace',
            scopeKey: 'server_1:/private/project',
            display: { t: 'plain', v: { label: 'Client Project' } },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    });

    expect(response.snapshot.pins).toHaveLength(1);
    expect(response.snapshot.schemaVersion).toBe(SESSION_ORGANIZATION_SNAPSHOT_VERSION);
    expect(response.snapshot.version).toBe(2);
    expect(response.snapshot.folderAssignments).toEqual([{ sessionId: 'session_1', folderId: 'folder_1' }]);
    expect(response.snapshot.labels[0]?.labelKind).toBe('workspace');
  });

  it('keeps schema version separate from monotonic account data version', () => {
    const baseSnapshot = {
      schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
      pins: [],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    };

    expect(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: { ...baseSnapshot, version: 0 } }).snapshot.version).toBe(0);
    expect(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: { ...baseSnapshot, version: 1 } }).snapshot.version).toBe(1);
    expect(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: { ...baseSnapshot, version: 12 } }).snapshot.version).toBe(12);
    expect(SessionOrganizationSnapshotResponseSchema.safeParse({ snapshot: { ...baseSnapshot, schemaVersion: 2, version: 1 } }).success).toBe(false);
  });

  it('carries attention standings through the snapshot and its set mutation', () => {
    expect(SessionOrganizationSnapshotRequestSchema.parse({}).includeAttentionStandings).toBe(false);
    expect(SessionOrganizationSnapshotRequestSchema.parse({ includeAttentionStandings: true }).includeAttentionStandings).toBe(true);

    const standing = SessionAttentionStandingSchema.parse({ sessionId: 'session_1', standing: true, updatedAt: 10 });
    expect(standing).toEqual({ sessionId: 'session_1', standing: true, updatedAt: 10 });

    const baseSnapshot = {
      schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
      version: 4,
      pins: [],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    };

    // The field is optional on the wire so a snapshot fetched without the include flag stays
    // parseable, and its absence stays distinguishable from "the account has none".
    expect(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: baseSnapshot }).snapshot.attentionStandings)
      .toBeUndefined();
    expect(
      SessionOrganizationSnapshotResponseSchema
        .parse({ snapshot: { ...baseSnapshot, attentionStandings: [standing] } })
        .snapshot.attentionStandings,
    ).toEqual([standing]);

    // "Remove from Needs attention" against a true account default is an explicit false, not a
    // missing row, so the mutation is a real tri-state.
    expect(SetSessionAttentionStandingRequestSchema.parse({ standing: false })).toEqual({ standing: false });
    expect(SetSessionAttentionStandingRequestSchema.parse({ standing: null })).toEqual({ standing: null });
    expect(SetSessionAttentionStandingResponseSchema.parse({ standing: null })).toEqual({ standing: null });
    expect(SetSessionAttentionStandingResponseSchema.parse({ standing }).standing).toEqual(standing);
    expect(SetSessionAttentionStandingRequestSchema.safeParse({}).success).toBe(false);
  });

  it('defines mutations for pins, folder delete defaults, tags, assignments, and ordering', () => {
    expect(SetSessionPinRequestSchema.parse({ pinned: true, sortKey: 'pin-a' })).toEqual({
      pinned: true,
      sortKey: 'pin-a',
    });
    expect(SetSessionPinRequestSchema.parse({ pinned: false, sortKey: null })).toEqual({
      pinned: false,
      sortKey: null,
    });

    expect(
      CreateOrUpdateSessionOrganizationFolderRequestSchema.parse({
        folderId: 'folder_1',
        folderKey: 'legacy/folder/1',
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: 'folder-a',
        display: { t: 'plain', v: { name: 'Projects' } },
      }).display,
    ).toEqual({ t: 'plain', v: { name: 'Projects' } });

    expect(DeleteSessionOrganizationFolderRequestSchema.parse({ folderId: 'folder_1' })).toEqual({
      folderId: 'folder_1',
      assignmentBehavior: SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT,
    });

    expect(SetSessionFolderAssignmentRequestSchema.parse({ folderId: null })).toEqual({ folderId: null });
    expect(
      SetSessionTagAssignmentsRequestSchema.parse({
        tagIds: ['tag_1', 'tag_2'],
      }),
    ).toEqual({ tagIds: ['tag_1', 'tag_2'] });

    expect(
      CreateOrUpdateSessionOrganizationTagRequestSchema.parse({
        tagId: 'tag_1',
        tagKey: 'legacy/tag/1',
        sortKey: null,
        display: { t: 'plain', v: { label: 'Blocked' } },
      }).display,
    ).toEqual({ t: 'plain', v: { label: 'Blocked' } });

    expect(DeleteSessionOrganizationTagRequestSchema.parse({ tagId: 'tag_1' })).toEqual({
      tagId: 'tag_1',
      assignmentBehavior: 'removeAssignments',
    });

    expect(
      ReorderSessionOrganizationRequestSchema.parse({
        scopeKind: 'pinned',
        scopeKey: 'global',
        entries: [
          {
            itemKind: 'session',
            itemKey: 'session_1',
            sortKey: 'a',
          },
        ],
      }),
    ).toEqual({
      scopeKind: 'pinned',
      scopeKey: 'global',
      entries: [{ itemKind: 'session', itemKey: 'session_1', sortKey: 'a' }],
    });
  });

  it('keeps DB-facing organization ids and sort keys provider-safe while allowing long legacy keys', () => {
    const providerSafeDbValue = 'x'.repeat(191);
    const providerUnsafeDbValue = 'x'.repeat(192);
    const longLegacyKey = 'legacy/'.concat('k'.repeat(2_000));

    expect(
      CreateOrUpdateSessionOrganizationFolderRequestSchema.safeParse({
        folderId: providerSafeDbValue,
        folderKey: longLegacyKey,
        parentFolderId: null,
        parentFolderKey: longLegacyKey,
        sortKey: providerSafeDbValue,
        display: null,
      }).success,
    ).toBe(true);

    expect(
      CreateOrUpdateSessionOrganizationFolderRequestSchema.safeParse({
        folderId: providerUnsafeDbValue,
        folderKey: longLegacyKey,
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: null,
        display: null,
      }).success,
    ).toBe(false);

    expect(
      CreateOrUpdateSessionOrganizationTagRequestSchema.safeParse({
        tagId: providerUnsafeDbValue,
        tagKey: longLegacyKey,
        sortKey: null,
        display: null,
      }).success,
    ).toBe(false);

    expect(
      SetSessionPinRequestSchema.safeParse({
        pinned: true,
        sortKey: providerUnsafeDbValue,
      }).success,
    ).toBe(false);

    expect(
      ReorderSessionOrganizationRequestSchema.safeParse({
        scopeKind: 'group',
        scopeKey: longLegacyKey,
        entries: [{
          itemKind: 'session',
          itemKey: longLegacyKey,
          sortKey: providerUnsafeDbValue,
        }],
      }).success,
    ).toBe(false);
  });

  it('rejects oversized display envelopes while preserving the canonical envelope shape', () => {
    const oversizedCiphertext = 'x'.repeat(SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES + 1);

    expect(
      CreateOrUpdateSessionOrganizationFolderRequestSchema.safeParse({
        folderKey: 'legacy/folder/oversized',
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: null,
        display: { t: 'encrypted', c: oversizedCiphertext },
      }).success,
    ).toBe(false);

    expect(
      CreateOrUpdateSessionOrganizationTagRequestSchema.safeParse({
        tagKey: 'legacy/tag/oversized',
        sortKey: null,
        display: { t: 'encrypted', c: oversizedCiphertext },
      }).success,
    ).toBe(false);

    expect(
      SessionOrganizationLabelSchema.safeParse({
        labelKind: 'workspace',
        scopeKey: 'server_1:/private/project',
        display: { t: 'encrypted', c: oversizedCiphertext },
        archivedAt: null,
        createdAt: 1,
        updatedAt: 2,
      }).success,
    ).toBe(false);

    expect(
      CreateOrUpdateSessionOrganizationFolderRequestSchema.safeParse({
        folderKey: 'legacy/folder/valid',
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: null,
        display: { t: 'plain', v: { name: 'Projects' } },
      }).success,
    ).toBe(true);
  });

  it('makes workspace labels first-class organization labels and omits collapsed group state', () => {
    expect(SESSION_ORGANIZATION_LABEL_KINDS).toContain('workspace');
    expect(SESSION_ORGANIZATION_ORDER_SCOPE_KINDS).not.toContain('collapsedGroup');

    const parsed = SessionOrganizationLabelSchema.parse({
      labelKind: 'workspace',
      scopeKey: 'server_1:/Users/me/project',
      display: { t: 'plain', v: { label: 'Project' } },
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    });

    expect(parsed.labelKind).toBe('workspace');
  });

  it('defines label mutation contracts for workspace label writes', () => {
    expect(
      UpsertSessionOrganizationLabelRequestSchema.parse({
        labelKind: 'workspace',
        scopeKey: 'server_1:/Users/me/project',
        display: { t: 'plain', v: { label: 'Project' } },
      }),
    ).toEqual({
      labelKind: 'workspace',
      scopeKey: 'server_1:/Users/me/project',
      display: { t: 'plain', v: { label: 'Project' } },
    });

    expect(
      DeleteSessionOrganizationLabelRequestSchema.parse({
        labelKind: 'workspace',
        scopeKey: 'server_1:/Users/me/project',
      }),
    ).toEqual({
      labelKind: 'workspace',
      scopeKey: 'server_1:/Users/me/project',
    });

    const oversizedCiphertext = 'x'.repeat(SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES + 1);
    expect(
      UpsertSessionOrganizationLabelRequestSchema.safeParse({
        labelKind: 'workspace',
        scopeKey: 'server_1:/Users/me/project',
        display: { t: 'encrypted', c: oversizedCiphertext },
      }).success,
    ).toBe(false);
  });

  it('defines a bounded legacy import batch contract for organization data', () => {
    const parsed = ImportLegacySessionOrganizationRequestSchema.parse({
      pins: [{ sessionId: 'session_1', sortKey: 'pin-a' }],
      folders: [{
        folderId: 'folder_1',
        folderKey: 'legacy/folder/1',
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: 'folder-a',
        display: { t: 'plain', v: { name: 'Inbox' } },
      }],
      tags: [{
        tagId: 'tag_1',
        tagKey: 'legacy/tag/1',
        sortKey: 'tag-a',
        display: { t: 'plain', v: { label: 'Important' } },
      }],
      tagAssignments: [{ sessionId: 'session_1', tagIds: ['tag_1'] }],
      orderEntries: [{
        scopeKind: 'workspace',
        scopeKey: 'server_1',
        itemKind: 'workspace',
        itemKey: 'server_1:/Users/me/project',
        sortKey: 'workspace-a',
      }],
      labels: [{
        labelKind: 'workspace',
        scopeKey: 'server_1:/Users/me/project',
        display: { t: 'plain', v: { label: 'Project' } },
      }],
    });

    expect(parsed.pins).toEqual([{ sessionId: 'session_1', sortKey: 'pin-a' }]);
    expect(parsed.tagAssignments).toEqual([{ sessionId: 'session_1', tagIds: ['tag_1'] }]);
    expect(parsed.labels[0]?.labelKind).toBe('workspace');
  });
});

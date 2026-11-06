import { describe, expect, it } from 'vitest';

import { SessionOrganizationSnapshotRequestSchema, SessionOrganizationSnapshotResponseSchema } from './snapshot.js';
import { SetSessionAppearanceRequestSchema, SetSessionAppearanceResponseSchema, SessionOrganizationSessionAppearanceSchema } from './appearances.js';
import { sessionOrganizationSnapshotRequestFromQueryV1 } from './snapshot.js';
import { AccountEncryptionMigrateSessionOrganizationDirectiveSchema } from '../../account/encryptionMigrate.js';
import { ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES } from '../../account/encryptionMigrate.js';
import { SessionOrganizationAccountEncryptionMigrationInventorySchema } from './accountEncryptionMigrationInventory.js';

describe('session appearance snapshot contract', () => {
  it('accepts a complete conversion inventory above the visible appearance quota', () => {
    const sessionAppearances = Array.from({ length: 1_001 }, (_, index) => ({
      sessionId: `s-${index}`, display: { t: 'plain', v: { color: 'violet' } },
    }));
    expect(SessionOrganizationAccountEncryptionMigrationInventorySchema.parse({
      version: 1, folders: [], tags: [], labels: [], sessionAppearances,
    }).sessionAppearances).toHaveLength(1_001);
  });

  it('accepts the complete retained appearance directive within the existing aggregate byte boundary', () => {
    const directive = { action: 'migrate', expectedVersion: 1, folders: [], tags: [], labels: [],
      sessionAppearances: Array.from({ length: 1_001 }, (_, index) => ({
        sessionId: `s-${index}`, expectedDisplay: { t: 'plain', v: { color: 'violet' } }, display: { t: 'encrypted', c: 'opaque' },
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(directive)).byteLength).toBeLessThan(ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES);
    const parsed = AccountEncryptionMigrateSessionOrganizationDirectiveSchema.parse(directive);
    expect(parsed.action === 'migrate' && parsed.sessionAppearances?.length).toBe(1_001);
  });

  it('keeps mutation ingress closed and explicitly represents unavailable display content', () => {
    const display = { t: 'plain', v: { color: { kind: 'custom', hex: '#123456' } } };
    const appearance = { sessionId: 's1', display, updatedAt: 1 };
    expect(SetSessionAppearanceRequestSchema.parse({ display })).toEqual({ display });
    expect(SetSessionAppearanceRequestSchema.parse({ display: null })).toEqual({ display: null });
    expect(SetSessionAppearanceRequestSchema.safeParse({ display, extra: true }).success).toBe(false);
    expect(SetSessionAppearanceResponseSchema.parse({ appearance })).toEqual({ appearance });
    expect(SessionOrganizationSessionAppearanceSchema.parse({ ...appearance, display: null,
      displayState: { status: 'unavailable', reason: 'invalid_stored_display' } }).displayState?.status).toBe('unavailable');
    expect(SessionOrganizationSessionAppearanceSchema.safeParse({ ...appearance, updatedAt: -1 }).success).toBe(false);
    expect(SessionOrganizationSnapshotRequestSchema.parse(sessionOrganizationSnapshotRequestFromQueryV1({ includeSessionAppearances: 'true' }))
      .includeSessionAppearances).toBe(true);
    expect(AccountEncryptionMigrateSessionOrganizationDirectiveSchema.parse({ action: 'migrate', expectedVersion: 1,
      folders: [], tags: [], labels: [], sessionAppearances: [{ sessionId: 's1', expectedDisplay: display, display: { t: 'encrypted', c: 'opaque' } }] })
      .action).toBe('migrate');
  });

  it('opts in without changing snapshots consumed by older clients', () => {
    expect(SessionOrganizationSnapshotRequestSchema.parse({}).includeSessionAppearances).toBe(false);
    expect(SessionOrganizationSnapshotRequestSchema.parse({ includeSessionAppearances: true }).includeSessionAppearances).toBe(true);
    const snapshot = {
      schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
      tags: [], tagAssignments: [], orderEntries: [], labels: [],
    };
    expect(SessionOrganizationSnapshotResponseSchema.parse({ snapshot }).snapshot).not.toHaveProperty('sessionAppearances');
    const appearance = { sessionId: 'session_1', display: { t: 'encrypted', c: 'opaque' }, updatedAt: 1 };
    expect(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: { ...snapshot, sessionAppearances: [appearance] } })
      .snapshot.sessionAppearances).toEqual([appearance]);
    expect(SessionOrganizationSnapshotResponseSchema.safeParse({ snapshot: {
      ...snapshot, sessionAppearances: Array.from({ length: 1_001 }, () => appearance),
    } }).success).toBe(false);
  });
});

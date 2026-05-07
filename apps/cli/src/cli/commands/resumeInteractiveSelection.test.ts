import { describe, expect, it, vi } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import { accountSettingsParse } from '@happier-dev/protocol';

import { buildResumeSelectionModel, formatResumeSelectionFooter } from './resumeInteractiveSelection';

/**
 * Pin down the resume selector behaviour:
 * - Active sessions never appear in the row list — only counted in the footer.
 * - Stopped + resumable sessions are listed, attachable group first.
 * - Stopped + ineligible sessions are listed disabled with a category-specific
 *   reason (vendor not supported, missing path, archived, etc.).
 */

function buildLegacyCredentials(): { credentials: Credentials; encryptionSecret: Uint8Array } {
  const secret = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) secret[i] = (i * 7 + 1) % 256;
  return {
    credentials: { token: 'test-token', encryption: { type: 'legacy', secret } },
    encryptionSecret: secret,
  };
}

function buildEncryptedSessionListRow(params: Readonly<{
  sessionId: string;
  agentId: string;
  active: boolean;
  archivedAt?: number | null;
  metadata: Record<string, unknown>;
  encryptionSecret: Uint8Array;
}>): RawSessionListRow {
  const encryptedMetadata = encryptLegacy(params.metadata, params.encryptionSecret);
  return {
    id: params.sessionId,
    seq: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    active: params.active,
    activeAt: 1_700_000_010_000,
    archivedAt: params.archivedAt ?? null,
    metadata: encodeBase64(encryptedMetadata),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    pendingCount: 0,
    encryptionMode: 'e2ee',
    encryption: { type: 'legacy' },
    title: null,
    path: typeof params.metadata.path === 'string' ? (params.metadata.path as string) : null,
    host: typeof params.metadata.host === 'string' ? (params.metadata.host as string) : null,
    share: null,
  } as unknown as RawSessionListRow;
}

describe('buildResumeSelectionModel', () => {
  it('lists a stopped vendor-resumable claude session as attachable', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentials();
    const rawSession = buildEncryptedSessionListRow({
      sessionId: 'sid-claude-stopped',
      agentId: 'claude',
      active: false,
      encryptionSecret,
      metadata: {
        host: 'leeroy-mbp',
        path: '/Users/leeroy/projects/atlas',
        agent: 'claude',
        flavor: 'claude',
        claudeSessionId: 'vendor-resume-id',
      },
    });

    const model = await buildResumeSelectionModel({
      credentials,
      accountSettings: accountSettingsParse({}),
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [rawSession], nextCursor: null, hasNext: false })),
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.disabled).toBe(false);
    expect(model.hint.resumableCount).toBe(1);
    expect(model.hint.ineligibleCount).toBe(0);
    expect(model.hint.activeRunningCount).toBe(0);
  });

  it('counts active sessions in the footer but never adds them to the row list', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentials();
    const activeSession = buildEncryptedSessionListRow({
      sessionId: 'sid-active',
      agentId: 'claude',
      active: true,
      encryptionSecret,
      metadata: {
        host: 'leeroy-mbp',
        path: '/p',
        agent: 'claude',
        flavor: 'claude',
        claudeSessionId: 'v',
      },
    });

    const model = await buildResumeSelectionModel({
      credentials,
      accountSettings: accountSettingsParse({}),
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [activeSession], nextCursor: null, hasNext: false })),
    });

    expect(model.rows).toHaveLength(0);
    expect(model.hint.activeRunningCount).toBe(1);
    expect(model.hint.resumableCount).toBe(0);
  });

  it('shows a stopped session whose agent does not support resume as DISABLED with a friendly reason', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentials();
    // opencode has no vendor resume capability — stopped opencode sessions are
    // shown disabled with the "agent does not support resume" reason.
    const rawSession = buildEncryptedSessionListRow({
      sessionId: 'sid-opencode',
      agentId: 'opencode',
      active: false,
      encryptionSecret,
      metadata: {
        host: 'leeroy-mbp',
        path: '/p',
        agent: 'opencode',
        flavor: 'opencode',
      },
    });

    const model = await buildResumeSelectionModel({
      credentials,
      accountSettings: accountSettingsParse({}),
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [rawSession], nextCursor: null, hasNext: false })),
    });

    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row?.disabled).toBe(true);
    expect(row?.disabledReason ?? '').toMatch(/does not support resume|cannot be resumed|vendor resume id is missing/i);
    expect(model.hint.ineligibleCount).toBe(1);
    expect(model.hint.resumableCount).toBe(0);
  });

  it('sorts resumable rows above disabled rows', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentials();
    const resumable = buildEncryptedSessionListRow({
      sessionId: 'sid-resumable',
      agentId: 'claude',
      active: false,
      encryptionSecret,
      metadata: { host: 'h', path: '/p', agent: 'claude', flavor: 'claude', claudeSessionId: 'v' },
    });
    const disabled = buildEncryptedSessionListRow({
      sessionId: 'sid-disabled',
      agentId: 'opencode',
      active: false,
      encryptionSecret,
      metadata: { host: 'h', path: '/p', agent: 'opencode', flavor: 'opencode' },
    });
    // Make disabled newer so we know ordering follows attachable-first not date-first.
    (disabled as unknown as { updatedAt: number }).updatedAt = (resumable as unknown as { updatedAt: number }).updatedAt + 1000;

    const model = await buildResumeSelectionModel({
      credentials,
      accountSettings: accountSettingsParse({}),
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [disabled, resumable], nextCursor: null, hasNext: false })),
    });

    expect(model.rows.map((row) => row.sessionId)).toEqual(['sid-resumable', 'sid-disabled']);
  });

  it('skips system sessions and archives entirely', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentials();
    const archived = buildEncryptedSessionListRow({
      sessionId: 'sid-archived',
      agentId: 'claude',
      active: false,
      archivedAt: 1_700_000_005_000,
      encryptionSecret,
      metadata: { host: 'h', path: '/p', agent: 'claude', flavor: 'claude', claudeSessionId: 'v' },
    });

    const model = await buildResumeSelectionModel({
      credentials,
      accountSettings: accountSettingsParse({}),
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [archived], nextCursor: null, hasNext: false })),
    });

    expect(model.rows).toHaveLength(0);
    expect(model.hint.ineligibleCount).toBe(0);
    expect(model.hint.resumableCount).toBe(0);
  });
});

describe('formatResumeSelectionFooter', () => {
  it('returns null when nothing useful to surface', () => {
    expect(formatResumeSelectionFooter({ ineligibleCount: 0, resumableCount: 3, activeRunningCount: 0 })).toBeNull();
  });

  it('mentions running sessions and points the user to happier attach', () => {
    const text = formatResumeSelectionFooter({ ineligibleCount: 0, resumableCount: 1, activeRunningCount: 2 });
    expect(text).toMatch(/2 sessions running/i);
    expect(text).toMatch(/happier attach/i);
  });

  it('mentions ineligible sessions when present', () => {
    const text = formatResumeSelectionFooter({ ineligibleCount: 2, resumableCount: 0, activeRunningCount: 0 });
    expect(text).toMatch(/can't be resumed/i);
  });

  it('combines both fragments when both are present', () => {
    const text = formatResumeSelectionFooter({ ineligibleCount: 1, resumableCount: 0, activeRunningCount: 1 });
    expect(text).toMatch(/running/i);
    expect(text).toMatch(/can't be resumed/i);
  });
});

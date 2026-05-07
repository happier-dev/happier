import { describe, expect, it, vi } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { accountSettingsParse } from '@happier-dev/protocol';

import { buildAttachSelectionModel, formatAttachIneligibilityFooter } from './attachInteractiveSelection';

/**
 * These tests pin down the high-impact behaviours we changed:
 * 1. Plain-mode codex sessions on this machine appear in the selector as
 *    `disabled: true` with a "started outside tmux" reason — this used to
 *    silently filter them out and produce "No active local sessions".
 * 2. Attachable rows sort above disabled rows.
 * 3. The footer hint reflects the user's actual `sessionUseTmux` state,
 *    including per-machine overrides.
 *
 * We use a real e2ee credentials/payload pair instead of mocks for the
 * encryption layer so we exercise the same decryption path the real
 * eligibility evaluator uses.
 */

function buildLegacyCredentialsAndKey(): { credentials: Credentials; encryptionSecret: Uint8Array } {
  const secret = new Uint8Array(32);
  // Fixed bytes for deterministic tests; the real key material is derived
  // identically to production via `legacyDataKeyDerivation`.
  for (let i = 0; i < 32; i += 1) secret[i] = (i * 7 + 1) % 256;
  return {
    credentials: {
      token: 'test-token',
      encryption: { type: 'legacy', secret },
    },
    encryptionSecret: secret,
  };
}

function buildEncryptedSessionListRow(params: Readonly<{
  sessionId: string;
  agentId: string;
  active: boolean;
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
    archivedAt: null,
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

describe('buildAttachSelectionModel', () => {
  it('shows a same-host plain-mode codex session as DISABLED with a tmux-related reason', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentialsAndKey();
    const sessionId = 'cmom-plain-codex-001';
    const rawSession = buildEncryptedSessionListRow({
      sessionId,
      agentId: 'codex',
      active: true,
      encryptionSecret,
      metadata: {
        host: 'leeroy-mbp',
        path: '/Users/leeroy/Documents/Development/atlas',
        agent: 'codex',
        terminal: { mode: 'plain' },
        // No machineId — the user's actual scenario where codex didn't
        // populate it. The host normalisation must still surface the row.
      },
    });

    const fetchSessionsPageFn = vi.fn(async () => ({
      sessions: [rawSession],
      nextCursor: null,
      hasNext: false,
    }));
    const readTerminalAttachmentInfoFn = vi.fn(async () => null as TerminalAttachmentInfo | null);
    const isTmuxAvailableFn = vi.fn(async () => true);

    const model = await buildAttachSelectionModel({
      credentials,
      currentMachineId: 'machine-a',
      currentMachineHost: 'leeroy-mbp.local',
      fetchSessionsPageFn,
      readTerminalAttachmentInfoFn,
      isTmuxAvailableFn,
      accountSettings: accountSettingsParse({ sessionUseTmux: false }),
    });

    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row.sessionId).toBe(sessionId);
    expect(row.disabled).toBe(true);
    expect(row.disabledReason).toMatch(/outside tmux/i);
    expect(row.annotation).toMatch(/outside tmux/i);

    expect(model.hint.attachableCount).toBe(0);
    expect(model.hint.ineligibleCount).toBe(1);
    expect(model.hint.dominantCategory).toBe('started_outside_tmux');
    expect(model.hint.effectiveSessionTmux?.useTmux).toBe(false);
  });

  it('sorts attachable rows above disabled rows, newest first within each group', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentialsAndKey();
    const plainOlder = buildEncryptedSessionListRow({
      sessionId: 'plain-older',
      agentId: 'codex',
      active: true,
      encryptionSecret,
      metadata: { host: 'leeroy-mbp', path: '/p1', agent: 'codex', terminal: { mode: 'plain' } },
    });
    const plainNewer = buildEncryptedSessionListRow({
      sessionId: 'plain-newer',
      agentId: 'codex',
      active: true,
      encryptionSecret,
      metadata: { host: 'leeroy-mbp', path: '/p2', agent: 'codex', terminal: { mode: 'plain' } },
    });
    // Bump newer one's updatedAt explicitly so sort order is deterministic.
    (plainNewer as unknown as { updatedAt: number }).updatedAt = (plainOlder as unknown as { updatedAt: number }).updatedAt + 1000;

    const fetchSessionsPageFn = vi.fn(async () => ({
      sessions: [plainOlder, plainNewer],
      nextCursor: null,
      hasNext: false,
    }));
    const readTerminalAttachmentInfoFn = vi.fn(async () => null as TerminalAttachmentInfo | null);
    const isTmuxAvailableFn = vi.fn(async () => true);

    const model = await buildAttachSelectionModel({
      credentials,
      currentMachineId: 'machine-a',
      currentMachineHost: 'leeroy-mbp',
      fetchSessionsPageFn,
      readTerminalAttachmentInfoFn,
      isTmuxAvailableFn,
      accountSettings: accountSettingsParse({ sessionUseTmux: false }),
    });

    // Both disabled (plain-mode), but newer should be first within group.
    expect(model.rows.map((row) => row.sessionId)).toEqual(['plain-newer', 'plain-older']);
  });

  it('explains same-host machine-id mismatches without calling them another physical machine', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentialsAndKey();
    const rawSession = buildEncryptedSessionListRow({
      sessionId: 'same-host-different-machine-id',
      agentId: 'codex',
      active: true,
      encryptionSecret,
      metadata: {
        host: 'leeroy-mbp',
        path: '/Users/leeroy/Documents/Development/atlas',
        agent: 'codex',
        machineId: 'machine-from-ui',
      },
    });

    const model = await buildAttachSelectionModel({
      credentials,
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp',
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [rawSession], nextCursor: null, hasNext: false })),
      readTerminalAttachmentInfoFn: vi.fn(async () => null),
      isTmuxAvailableFn: vi.fn(async () => true),
      accountSettings: accountSettingsParse({ sessionUseTmux: true }),
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].disabled).toBe(true);
    expect(model.rows[0].annotation).toMatch(/machine identity/i);
    expect(model.rows[0].disabledReason).toMatch(/machine identity/i);
    expect(model.hint.dominantCategory).toBe('machine_identity_mismatch');

    const footer = formatAttachIneligibilityFooter(model.hint);
    expect(footer).toMatch(/machine identity/i);
    expect(footer).not.toMatch(/other machines/i);
  });

  it('skips sessions whose host does not match this machine', async () => {
    const { credentials, encryptionSecret } = buildLegacyCredentialsAndKey();
    const remoteSession = buildEncryptedSessionListRow({
      sessionId: 'remote-001',
      agentId: 'codex',
      active: true,
      encryptionSecret,
      metadata: { host: 'other-machine', path: '/p', agent: 'codex', terminal: { mode: 'tmux' } },
    });

    const model = await buildAttachSelectionModel({
      credentials,
      currentMachineId: 'machine-a',
      currentMachineHost: 'leeroy-mbp',
      fetchSessionsPageFn: vi.fn(async () => ({ sessions: [remoteSession], nextCursor: null, hasNext: false })),
      readTerminalAttachmentInfoFn: vi.fn(async () => null),
      isTmuxAvailableFn: vi.fn(async () => true),
      accountSettings: accountSettingsParse({ sessionUseTmux: true }),
    });

    expect(model.rows).toHaveLength(0);
    expect(model.hint.ineligibleCount).toBe(0);
  });
});

describe('formatAttachIneligibilityFooter', () => {
  it('returns null when there are no ineligible rows', () => {
    expect(formatAttachIneligibilityFooter({
      dominantCategory: null,
      attachableCount: 3,
      ineligibleCount: 0,
      effectiveSessionTmux: { useTmux: true, source: 'global' },
    })).toBeNull();
  });

  it('suggests enabling Spawn Sessions in Tmux when the dominant cause is plain mode + tmux disabled', () => {
    const text = formatAttachIneligibilityFooter({
      dominantCategory: 'started_outside_tmux',
      attachableCount: 0,
      ineligibleCount: 2,
      effectiveSessionTmux: { useTmux: false, source: 'global' },
    });
    expect(text).toMatch(/started outside tmux/i);
    expect(text).toMatch(/Spawn Sessions in Tmux/i);
  });

  it('switches the wording when tmux is already enabled (sessions are pre-toggle)', () => {
    const text = formatAttachIneligibilityFooter({
      dominantCategory: 'started_outside_tmux',
      attachableCount: 1,
      ineligibleCount: 1,
      effectiveSessionTmux: { useTmux: true, source: 'global' },
    });
    expect(text).toMatch(/before "Spawn Sessions in Tmux" was enabled/i);
  });

  it('explains tmux missing when the dominant cause is tmux not installed', () => {
    const text = formatAttachIneligibilityFooter({
      dominantCategory: 'tmux_unavailable',
      attachableCount: 0,
      ineligibleCount: 3,
      effectiveSessionTmux: { useTmux: true, source: 'global' },
    });
    expect(text).toMatch(/install tmux/i);
  });

  it('explains hidden Windows sessions without daemon restart guidance', () => {
    const text = formatAttachIneligibilityFooter({
      dominantCategory: 'windows_hidden',
      attachableCount: 0,
      ineligibleCount: 2,
      effectiveSessionTmux: { useTmux: true, source: 'global' },
    });
    expect(text).toMatch(/hidden Windows/i);
    expect(text).toMatch(/visible terminal/i);
    expect(text).not.toMatch(/daemon start/i);
  });

  it('points the user at archives when the dominant cause is archived/inactive', () => {
    const text = formatAttachIneligibilityFooter({
      dominantCategory: 'archived_or_inactive',
      attachableCount: 0,
      ineligibleCount: 2,
      effectiveSessionTmux: null,
    });
    expect(text).toMatch(/happier resume/i);
  });
});

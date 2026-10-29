import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { reloadConfiguration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { accountSettingsParse } from '@happier-dev/protocol';

import { buildContinueSelectionModel, buildResumeSelectionModel, formatResumeSelectionFooter } from './resumeInteractiveSelection';
import { handleResumeCommand } from './resume';

const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

describe('buildContinueSelectionModel', () => {
  it.each([true, false])('reconciles recent active=%s with the active feed without losing older running sessions or stopped eligibility', async (recentActive) => {
    const terminal = {
      mode: 'herdr' as const, requested: 'herdr' as const,
      herdr: { sessionName: 'main', socketPath: '/tmp/herdr.sock', terminalId: 'term-1' },
    };
    const active = createSessionRecordFixture({
      id: 'sid-active', active: true, encryptionMode: 'plain',
      metadata: JSON.stringify({
        host: 'local-host', machineId: 'machine-local', path: '/p', flavor: 'claude',
        terminal,
      }),
    });
    const stopped = createSessionRecordFixture({
      id: 'sid-stopped', active: false, encryptionMode: 'plain',
      metadata: JSON.stringify({ host: 'local-host', path: '/p', flavor: 'claude', claudeSessionId: 'vendor-id' }),
    });
    const recentVersion = { ...active, active: recentActive };
    const olderActive = { ...active, id: 'sid-older-active', updatedAt: active.updatedAt - 1000 };
    const missingVendorId = createSessionRecordFixture({
      id: 'sid-no-vendor-id', active: false, encryptionMode: 'plain',
      metadata: JSON.stringify({ host: 'local-host', path: '/p', flavor: 'claude' }),
    });
    const model = await buildContinueSelectionModel({
      credentials,
      accountSettings: accountSettingsParse({}),
      accountEncryptionMode: 'plain',
      contributionRegistry: null,
      currentMachineId: 'machine-local',
      currentMachineHost: 'local-host',
      fetchSessionsPageFn: async ({ activeOnly }) => ({
        sessions: activeOnly ? [active, olderActive] : [recentVersion, stopped, missingVendorId],
        nextCursor: null,
        hasNext: false,
      }),
      readTerminalAttachmentInfoFn: async ({ sessionId }) => sessionId === active.id || sessionId === olderActive.id
        ? { version: 1, sessionId, terminal, updatedAt: Date.now() }
        : null,
      isTmuxAvailableFn: async () => true,
    });
    expect(model.rows.map((row) => row.sessionId)).toEqual(['sid-active', 'sid-stopped', 'sid-older-active', 'sid-no-vendor-id']);
    expect(model.rows.find((row) => row.sessionId === 'sid-active')).toMatchObject({ disabled: false, annotation: 'running' });
    expect(model.rows.find((row) => row.sessionId === 'sid-stopped')).toMatchObject({ disabled: false, annotation: 'stopped' });
    expect(model.rows.find((row) => row.sessionId === 'sid-no-vendor-id')).toMatchObject({ disabled: true });
    expect(model.footerHint).toMatch(/1 session cannot be resumed/i);
  });
});

describe('buildResumeSelectionModel', () => {
  it.each(['empty', 'mixed'] as const)('shows metadata upgrade guidance for an %s resume selection page', async (kind) => {
    const readable = createSessionRecordFixture({
      id: 'sid_readable',
      active: false,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        path: '/tmp/claude-workspace',
        claudeSessionId: 'claude-vendor-1',
        claudeTranscriptPath: '/tmp/claude-workspace/claude-vendor-1.jsonl',
      }),
    });
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        sessions: kind === 'mixed' ? [readable] : [],
        nextCursor: null,
        hasNext: false,
        metadataUpgradeRequiredCount: 1,
      },
    });
    try {
      // HTTP is the only substituted boundary; the real parser, row model and footer run.
      const model = await runWithServerHttpBaseUrl('https://home.example.test', () => buildResumeSelectionModel({
        credentials,
        accountEncryptionMode: 'plain',
        accountSettings: accountSettingsParse({}),
        contributionRegistry: null,
        fetchSessionsPageFn: fetchSessionsPage,
      }));

      expect(model.rows.map((row) => row.sessionId)).toEqual(kind === 'mixed' ? ['sid_readable'] : []);
      expect(formatResumeSelectionFooter(model.hint)).toEqual(expect.stringMatching(/incomplete.*owner.*upgrade/i));
    } finally {
      get.mockRestore();
    }
  });

  it('prints metadata upgrade guidance from the empty interactive resume command', async () => {
    const taskHome = await mkdtemp(join(tmpdir(), 'happier-resume-metadata-omission-'));
    vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    reloadConfiguration();
    resetInMemoryAccountSettingsContextForTests();
    const output = captureConsoleText();
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (path === '/v2/sessions' || path === '/v2/sessions/active') return { status: 200, data: {
        sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1,
      } };
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    try {
      await runWithServerHttpBaseUrl('https://home.example.test', () => handleResumeCommand([], {
        // Credential storage and raw TTY detection are the only non-HTTP adapters.
        readCredentialsFn: async () => credentials,
        canUseInkSelectorFn: () => true,
      }));

      expect(output.text()).toContain('No sessions available to continue from here.');
      expect(output.text()).toMatch(/incomplete.*owner.*upgrade/i);
    } finally {
      get.mockRestore();
      output.restore();
      resetInMemoryAccountSettingsContextForTests();
      vi.unstubAllEnvs();
      reloadConfiguration();
      await rm(taskHome, { recursive: true, force: true });
    }
  });

  it('shows stopped non-resumable sessions as disabled rows', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_stopped_opencode_1',
      active: false,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
      }),
    });

    const model = await buildResumeSelectionModel({
      credentials,
      accountEncryptionMode: 'plain',
      accountSettings: accountSettingsParse({}),
      contributionRegistry: null,
      fetchSessionsPageFn: vi.fn(async () => ({
        sessions: [rawSession],
        nextCursor: null,
        hasNext: false,
      })),
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      sessionId: 'sid_stopped_opencode_1',
      disabled: true,
    });
    expect(model.rows[0]?.disabledReason).toMatch(/resume/i);
    expect(model.hint.ineligibleCount).toBe(1);
  });

  it('sorts resumable rows ahead of disabled rows', async () => {
    const resumable = createSessionRecordFixture({
      id: 'sid_resumable_1',
      active: false,
      updatedAt: 10,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        path: '/tmp/claude-workspace',
        claudeSessionId: 'claude-vendor-1',
        claudeTranscriptPath: '/tmp/claude-workspace/claude-vendor-1.jsonl',
      }),
    });
    const disabled = createSessionRecordFixture({
      id: 'sid_disabled_1',
      active: false,
      updatedAt: 20,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
      }),
    });

    const model = await buildResumeSelectionModel({
      credentials,
      accountEncryptionMode: 'plain',
      accountSettings: accountSettingsParse({}),
      contributionRegistry: null,
      fetchSessionsPageFn: vi.fn(async () => ({
        sessions: [disabled, resumable],
        nextCursor: null,
        hasNext: false,
      })),
    });

    expect(model.rows.map((row) => row.sessionId)).toEqual(['sid_resumable_1', 'sid_disabled_1']);
  });
});

describe('formatResumeSelectionFooter', () => {
  it('points active sessions at attach and summarizes disabled rows', () => {
    expect(formatResumeSelectionFooter({
      activeRunningCount: 1,
      ineligibleCount: 2,
      resumableCount: 0,
    })).toMatch(/happier attach/i);
  });
});

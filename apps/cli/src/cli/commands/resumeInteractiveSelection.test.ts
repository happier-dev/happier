import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { accountSettingsParse } from '@happier-dev/protocol';

import { buildResumeSelectionModel, formatResumeSelectionFooter } from './resumeInteractiveSelection';

const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

describe('buildResumeSelectionModel', () => {
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

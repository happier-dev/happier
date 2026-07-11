import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type HostRuntimeControlServiceV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkCodexUsageLimitRecoveryNow,
  consumeCodexUsageLimitResetCredit,
} from './usageLimitRecovery.js';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function createWaitingIntent(overrides: Partial<SessionUsageLimitRecoveryV1> = {}): SessionUsageLimitRecoveryV1 {
  return {
    v: 1,
    status: 'waiting',
    resumePromptMode: 'standard',
    issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
    armedAtMs: 1_700_000_000_000,
    resetAtMs: null,
    nextCheckAtMs: null,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    ...overrides,
  };
}

function createUsageLimitRuntimeIssue(agentTurnId: string) {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    agentTurnId,
    occurredAt: agentTurnId === 'turn-1' ? 1_700_000_000_000 : 1_700_000_100_000,
    usageLimit: {
      v: 1,
      resetAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
    },
  };
}

function createRuntimeControlStub(
  request = vi.fn(async () => ({ ok: false as const, error: 'unexpected probe' })),
  context: Partial<HostRuntimeControlServiceV1['context']> = {},
) {
  // Boundary harness stub: only the appServer.request surface is exercised by checkNow.
  return {
    runtimeControl: { context, appServer: { request } } as unknown as HostRuntimeControlServiceV1,
    request,
  };
}

describe('checkCodexUsageLimitRecoveryNow', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('clears a persisted pending intent without probing when the latest turn completed normally', async () => {
    const { runtimeControl, request } = createRuntimeControlStub();

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: { latestTurnStatus: 'completed' },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_superseded_by_turn_completion',
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          status: 'cancelled',
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps probing a persisted pending intent when the latest turn is still failed', async () => {
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: { rateLimits: null },
    })));

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        sessionId: 'sess-reset',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: { latestTurnStatus: 'failed' },
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps probing a persisted pending intent when turn status evidence is unavailable', async () => {
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: { rateLimits: null },
    })));

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: {},
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit custom resume prompt mode when arming from the latest failed issue', async () => {
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: { rateLimits: null },
    })));

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: {},
        rawSession: {
          latestTurnStatus: 'failed',
          lastRuntimeIssue: {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            provider: 'codex',
            agentTurnId: 'turn-1',
            occurredAt: 1_700_000_000_000,
            usageLimit: {
              v: 1,
              resetAtMs: null,
              retryAfterMs: null,
              quotaScope: 'account',
              recoverability: 'wait',
            },
          },
        },
        resumePromptMode: 'custom',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          resumePromptMode: 'custom',
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('consumes a reset credit with native Codex auth before refreshing recovery state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-reset-consume-'));
    tempDirs.push(dir);
    const codexHome = join(dir, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({
            email: 'valid@example.test',
            chatgpt_account_id: 'acct-chatgpt',
            exp: 4_102_444_800,
          }),
          access_token: buildJwt({ exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ code: 'reset', windows_reset: 2 }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: {
        rateLimits: {
          primary: { usedPercent: 0 },
        },
      },
    })), { processEnv: { CODEX_HOME: codexHome } });

    const result = await consumeCodexUsageLimitResetCredit({
      runtimeControl,
      params: {
        sessionId: 'sess-reset',
        cwd: '/repo',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: { latestTurnStatus: 'failed' },
      },
    });
    const expectedIdempotencyKey = 'session:sess-reset:codex_reset_credit:usage-limit:codex:turn-1:1700000000000:no-reset';

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
          'ChatGPT-Account-Id': 'acct-chatgpt',
        }),
        body: JSON.stringify({
          redeem_request_id: expectedIdempotencyKey,
        }),
      }),
    );
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'account/rateLimits/read',
    }));
  });

  it('uses a distinct native reset-credit idempotency key for each recovery issue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-reset-issue-key-'));
    tempDirs.push(dir);
    const codexHome = join(dir, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({
            email: 'valid@example.test',
            chatgpt_account_id: 'acct-chatgpt',
            exp: 4_102_444_800,
          }),
          access_token: buildJwt({ exp: 4_102_444_800 }),
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ code: 'reset', windows_reset: 2 }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { runtimeControl } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: {
        rateLimits: {
          primary: { usedPercent: 0 },
        },
      },
    })), { processEnv: { CODEX_HOME: codexHome } });

    await expect(consumeCodexUsageLimitResetCredit({
      runtimeControl,
      params: {
        sessionId: 'sess-reset',
        cwd: '/repo',
        metadata: {},
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
        rawSession: {
          latestTurnStatus: 'failed',
          lastRuntimeIssue: createUsageLimitRuntimeIssue('turn-1'),
        },
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(consumeCodexUsageLimitResetCredit({
      runtimeControl,
      params: {
        sessionId: 'sess-reset',
        cwd: '/repo',
        metadata: {},
        issueFingerprint: 'usage-limit:codex:turn-2:1700000100000:no-reset',
        rawSession: {
          latestTurnStatus: 'failed',
          lastRuntimeIssue: createUsageLimitRuntimeIssue('turn-2'),
        },
      },
    })).resolves.toMatchObject({ ok: true });

    const firstBody = JSON.parse(String(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body,
    )) as Readonly<{ redeem_request_id?: string }>;
    const secondBody = JSON.parse(String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body,
    )) as Readonly<{ redeem_request_id?: string }>;
    const firstKey = firstBody.redeem_request_id;
    const secondKey = secondBody.redeem_request_id;
    expect(firstKey).toContain('turn-1');
    expect(secondKey).toContain('turn-2');
    expect(secondKey).not.toBe(firstKey);
  });
});

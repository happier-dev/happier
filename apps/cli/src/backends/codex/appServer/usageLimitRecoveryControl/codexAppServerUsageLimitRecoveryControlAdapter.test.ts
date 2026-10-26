import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUsageLimitRecoveryControlAdapterParams } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import type { CodexAppServerClient } from '../client/createCodexAppServerClient';
import { createCodexAppServerUsageLimitRecoveryControlAdapter } from './codexAppServerUsageLimitRecoveryControlAdapter';

type RunWithControlClient = NonNullable<Parameters<typeof createCodexAppServerUsageLimitRecoveryControlAdapter>[0]>['runWithControlClient'];
type RunWithControlClientParams = Parameters<NonNullable<RunWithControlClient>>[0];

function createClient(request: CodexAppServerClient['request']): CodexAppServerClient {
  return {
    request,
    notify: async () => {},
    registerRequestHandler: () => () => {},
    registerNotificationHandler: () => () => {},
  };
}

function createParams(
  metadata: Record<string, unknown>,
  rawSessionOverrides: Partial<SessionUsageLimitRecoveryControlAdapterParams['rawSession']> = {},
): SessionUsageLimitRecoveryControlAdapterParams {
  return {
    token: 'token',
    sessionId: 'sess_1',
    rawSession: {
      id: 'sess_1',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      path: '/repo',
      machineId: 'machine-local',
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      ...rawSessionOverrides,
    },
    metadata,
    currentMachineId: 'machine-local',
    sessionMachineId: 'machine-local',
    cwd: '/repo',
    ctx: {
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy' as const,
    },
    mode: 'plain' as const,
  };
}

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('codexAppServerUsageLimitRecoveryControlAdapter', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('probes Codex rate limits with a temporary app-server control client and marks ready when lifted', async () => {
    const controlClientCalls: RunWithControlClientParams[] = [];
    const runWithControlClient: RunWithControlClient = async (params) => {
      controlClientCalls.push(params);
      return {
        ok: true,
        value: await params.run(createClient(async (method) => {
        expect(method).toBe('account/rateLimits/read');
        return { primary: { used_percent: 42 } };
        })),
      };
    };
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'thread-1' },
      },
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
      },
    };

    await expect(adapter.checkNow?.(createParams(metadata))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          attemptCount: 0,
        },
      },
    });
    expect(controlClientCalls[0]).toEqual(expect.objectContaining({
      cwd: '/repo',
      metadata,
    }));
  });

  it('arms a check from the latest failed usage-limit issue when no persisted intent exists', async () => {
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => ({ primary: { used_percent: 42 } }))),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'thread-1' },
      },
    };

    await expect(adapter.checkNow?.(createParams(metadata, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        provider: 'codex',
        providerTurnId: 'turn-1',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: 1_700_000_060_000,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    }))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
          selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
        },
      },
    });
  });

  it('preserves group identity when the latest failed usage-limit issue has no active profile id', async () => {
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => ({
        primary: { usedPercent: 100 },
      }))),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'thread-1' },
      },
    };

    await expect(adapter.checkNow?.(createParams(metadata, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        provider: 'codex',
        providerTurnId: 'turn-1',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: 120_000,
          quotaScope: 'account',
          recoverability: 'wait',
          connectedService: {
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: null,
          },
        },
      },
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          selectedAuth: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: null,
          },
        },
      },
    });
  });

  it('keeps waiting and records the reset time when Codex still reports exhaustion', async () => {
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => ({
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 100, resetsAt: 1_779_098_400 },
        },
        rateLimitsByLimitId: null,
      }))),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'thread-1' },
      },
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
      },
    };

    await expect(adapter.checkNow?.(createParams(metadata))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'waiting',
          attemptCount: 0,
          nextCheckAtMs: Date.parse('2026-05-18T10:00:00.000Z'),
        },
      },
    });
  });

  it('exhausts stale Codex app-server recovery intents instead of probing after max attempts', async () => {
    const controlClientCalls: RunWithControlClientParams[] = [];
    const runWithControlClient: RunWithControlClient = async (params) => {
      controlClientCalls.push(params);
      return {
        ok: true,
        value: await params.run(createClient(async () => ({
          rateLimits: {
            planType: 'pro',
            primary: { usedPercent: 100, resetsAt: 1_779_098_400 },
          },
          rateLimitsByLimitId: null,
        }))),
      };
    };
    const intent: SessionUsageLimitRecoveryV1 = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      resetAtMs: null,
      nextCheckAtMs: null,
      attemptCount: 1,
      maxAttempts: 1,
      lastProbeError: null,
      resumePromptMode: 'standard',
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    };
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'thread-1' },
      },
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent,
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'exhausted',
          attemptCount: 2,
          lastProbeError: 'usage_limit_recovery_max_attempts_exhausted',
        },
      },
    });
    expect(controlClientCalls).toEqual([]);
  });

  it('keeps retry-after-derived check timing when Codex remains exhausted without a reset timestamp', async () => {
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => ({
        primary: { usedPercent: 100 },
      }))),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'thread-1' },
      },
    };

    await expect(adapter.checkNow?.(createParams(metadata, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        provider: 'codex',
        providerTurnId: 'turn-1',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: null,
          retryAfterMs: 120_000,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      },
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'waiting',
          resetAtMs: null,
          nextCheckAtMs: 1_700_000_120_000,
        },
      },
    });
  });

  it('returns stable unsupported for non-app-server Codex check-now without probing rate limits', async () => {
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => {
        throw new Error('must not probe non-app-server mode');
      })),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({ runWithControlClient });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'mcp', vendorSessionId: 'thread-1' },
      },
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
      },
    };

    await expect(adapter.checkNow?.(createParams(metadata))).resolves.toEqual({
      ok: false,
      errorCode: 'codex_quota_probe_unsupported_for_backend_mode',
      error: 'codex_quota_probe_unsupported_for_backend_mode',
    });
  });

  it('consumes a native Codex reset credit then probes rate limits and marks recovery ready', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-reset-native-home-'));
    tempDirs.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          account_id: 'acct-native',
        },
      }),
      'utf8',
    );
    const fetchRuntime = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ code: 'reset', windows_reset: 2 }) } as Response;
      }
      expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          available_count: 1,
          credits: [{ id: 'credit-native-1', reset_type: 'codex_rate_limits', status: 'available' }],
        }),
      } as Response;
    });
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async (method) => {
        expect(method).toBe('account/rateLimits/read');
        return { primary: { used_percent: 12 } };
      })),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({
      runWithControlClient,
      fetchRuntime,
    });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'thread-1',
        home: 'user',
        homePath: codexHome,
      }),
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
      },
    };

    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          attemptCount: 0,
        },
      },
    });
    expect(fetchRuntime).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
          'ChatGPT-Account-Id': 'acct-native',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          redeem_request_id: 'usage-limit:sess_1:reset:reset-credit',
          credit_id: 'credit-native-1',
        }),
      }),
    );
  });

  it('uses aggregate redemption when the provider reports available credits without detail ids', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-reset-native-aggregate-home-'));
    tempDirs.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          account_id: 'acct-native',
        },
      }),
      'utf8',
    );
    const fetchRuntime = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 'reset', windows_reset: 2 }),
        } as Response;
      }
      expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
      return {
        ok: true,
        status: 200,
        json: async () => ({ available_count: 1, credits: [] }),
      } as Response;
    });
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => ({ primary: { used_percent: 12 } }))),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({
      runWithControlClient,
      fetchRuntime,
    });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'thread-1',
        home: 'user',
        homePath: codexHome,
      }),
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
      },
    };

    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
    });
    expect(fetchRuntime).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          redeem_request_id: 'usage-limit:sess_1:reset:reset-credit',
        }),
      }),
    );
  });

  it('does not consume a live Codex reset credit unless the provider marks it available', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-reset-unavailable-home-'));
    tempDirs.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          account_id: 'acct-native',
        },
      }),
      'utf8',
    );
    const fetchRuntime = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ code: 'reset', windows_reset: 2 }) } as Response;
      }
      expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          available_count: 0,
          credits: [{ id: 'credit-native-1', reset_type: 'codex_rate_limits', status: 'redeemed' }],
        }),
      } as Response;
    });
    const runWithControlClient = vi.fn(async (params: RunWithControlClientParams) => ({
      ok: true,
      value: await params.run(createClient(async () => ({ primary: { used_percent: 12 } }))),
    }));
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({
      runWithControlClient: runWithControlClient as RunWithControlClient,
      fetchRuntime,
    });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'thread-1',
        home: 'user',
        homePath: codexHome,
      }),
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
        recoveryCredits: {
          kind: 'usage_limit_resets',
          availableCount: 1,
          totalCount: 1,
          source: 'provider_api',
          confidence: 'exact',
          credits: [{
            providerCreditId: 'credit-persisted-stale',
            kind: 'rate_limit_reset',
            status: 'available',
            providerResetType: 'codex_rate_limits',
          }],
        },
      },
    };

    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toEqual({
      ok: false,
      errorCode: 'codex_reset_credit_no_available_credit',
      error: 'codex_reset_credit_no_available_credit',
    });
    expect(fetchRuntime).not.toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.anything(),
    );
    expect(runWithControlClient).not.toHaveBeenCalled();
  });

  it('does not consume a persisted Codex reset credit fallback unless it is available', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-reset-stale-home-'));
    tempDirs.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          access_token: buildJwt({ email: 'native@example.test', exp: 4_102_444_800 }),
          account_id: 'acct-native',
        },
      }),
      'utf8',
    );
    const fetchRuntime = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ code: 'reset', windows_reset: 2 }) } as Response;
      }
      expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: 'temporarily_unavailable' }),
      } as Response;
    });
    const runWithControlClient = vi.fn(async (params: RunWithControlClientParams) => ({
      ok: true,
      value: await params.run(createClient(async () => ({ primary: { used_percent: 12 } }))),
    }));
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({
      runWithControlClient: runWithControlClient as RunWithControlClient,
      fetchRuntime,
    });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'thread-1',
        home: 'user',
        homePath: codexHome,
      }),
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
        recoveryCredits: {
          kind: 'usage_limit_resets',
          availableCount: 0,
          totalCount: 1,
          source: 'provider_api',
          confidence: 'exact',
          credits: [{
            providerCreditId: 'credit-stale-1',
            kind: 'rate_limit_reset',
            status: 'redeemed',
            providerResetType: 'codex_rate_limits',
          }],
        },
      },
    };

    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toEqual({
      ok: false,
      errorCode: 'codex_reset_credit_no_available_credit',
      error: 'codex_reset_credit_no_available_credit',
    });
    expect(fetchRuntime).not.toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.anything(),
    );
    expect(runWithControlClient).not.toHaveBeenCalled();
  });

  it.each(['profile', 'group'] as const)('consumes a connected-service Codex reset credit through the daemon for the exact %s profile', async (kind) => {
    const consumeConnectedServiceResetCredit = vi.fn(async (): Promise<unknown> => ({
      ok: true,
      snapshot: null,
      receipt: { idempotencyKey: 'key', status: 'consumed' },
    }));
    const fetchRuntime = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ code: 'reset', windows_reset: 2 }) } as Response;
      }
      expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          available_count: 1,
          credits: [{ id: 'credit-connected-1', reset_type: 'codex_rate_limits', status: 'available' }],
        }),
      } as Response;
    });
    const resolveConnectedServiceResetCreditAuth = vi.fn(async () => ({
      accessToken: 'connected-access',
      accountId: 'acct-connected',
    }));
    const runWithControlClient: RunWithControlClient = async (params) => ({
      ok: true,
      value: await params.run(createClient(async () => ({ primary: { used_percent: 12 } }))),
    });
    const adapter = createCodexAppServerUsageLimitRecoveryControlAdapter({
      runWithControlClient,
      fetchRuntime,
      resolveConnectedServiceResetCreditAuth,
      consumeConnectedServiceResetCredit,
    });
    const metadata = {
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'thread-1',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
      }),
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: 2,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: {
          kind,
          ...(kind === 'group' ? { groupId: 'pool' } : {}),
          serviceId: 'openai-codex',
          profileId: 'work',
        },
      },
    };

    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
    });
    expect(resolveConnectedServiceResetCreditAuth).toHaveBeenCalledWith(expect.objectContaining({
      selectedAuth: {
        kind,
        ...(kind === 'group' ? { groupId: 'pool' } : {}),
        serviceId: 'openai-codex',
        profileId: 'work',
      },
    }));
    expect(consumeConnectedServiceResetCredit).toHaveBeenCalledWith({
      serviceId: 'openai-codex', profileId: 'work',
      idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:aggregate:unknown',
    });
    expect(fetchRuntime.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
    consumeConnectedServiceResetCredit.mockResolvedValue({
      ok: true, snapshot: null, receipt: { idempotencyKey: 'key', status: 'not_available' },
    });
    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: false, errorCode: 'no_credit',
    });
    consumeConnectedServiceResetCredit.mockResolvedValue({
      ok: true, snapshot: null, receipt: { idempotencyKey: 'key', status: 'unknown_after_timeout' },
    });
    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_quota_recovery_credit_unknown_after_timeout',
    });
    consumeConnectedServiceResetCredit.mockResolvedValue({
      ok: false, errorCode: 'connected_service_quota_refresh_timeout', error: 'timeout',
      receipt: { idempotencyKey: 'key', status: 'consumed' },
    });
    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_quota_refresh_timeout',
    });
    consumeConnectedServiceResetCredit.mockResolvedValue({ ok: true });
    await expect(adapter.consumeResetCredit?.(createParams(metadata))).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_quota_recovery_credit_unsupported_response',
    });
  });
});

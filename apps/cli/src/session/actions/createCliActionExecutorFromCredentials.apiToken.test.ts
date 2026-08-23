import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';

import { configuration } from '@/configuration';

const {
  createCliActionExecutor,
  ensureCliActionPolicySettings,
  fetchSessionById,
  fetchSessionsPage,
  importHistoricalSessionTranscript,
  lookupSessionsByTags,
} = vi.hoisted(() => ({
  createCliActionExecutor: vi.fn(),
  ensureCliActionPolicySettings: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  importHistoricalSessionTranscript: vi.fn(),
  lookupSessionsByTags: vi.fn(),
}));

vi.mock('./createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('./ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
  fetchSessionsPage,
  importHistoricalSessionTranscript,
  lookupSessionsByTags,
}));

const exactSessionId = 'c123456789012345678901234';
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function apiSuccess(actionId: string, result: unknown): Response {
  return new Response(JSON.stringify({
    v: 1,
    actionId,
    execution: { ok: true, result },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function apiFailure(actionId: string, errorCode: string, details?: unknown): Response {
  return new Response(JSON.stringify({
    v: 1,
    actionId,
    execution: {
      ok: false,
      errorCode,
      error: errorCode,
      ...(details === undefined ? {} : { details }),
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createCliActionExecutorFromCredentials API Token transport', () => {
  beforeEach(() => {
    createCliActionExecutor.mockReset();
    createCliActionExecutor.mockReturnValue({
      prepare: vi.fn(),
      execute: vi.fn(async () => ({ ok: false, errorCode: 'local_executor_used', error: 'local_executor_used' })),
    });
    ensureCliActionPolicySettings.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    importHistoricalSessionTranscript.mockReset();
    lookupSessionsByTags.mockReset();
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: ['active-work'],
      sessions: [{ id: exactSessionId }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('composes Account-server-owned Actions into the executor used by the daemon ingress', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: { tokens: [] },
    });
    onTestFinished(() => post.mockRestore());
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');

    createCliActionExecutorFromCredentials({
      credentials: {
        token: 'signed-daemon-account-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      },
    });

    const accountApiTokensListAction = createCliActionExecutor.mock.calls.at(-1)?.[0]
      ?.accountApiTokensListAction;
    expect(accountApiTokensListAction).toEqual(expect.any(Function));
    await expect(accountApiTokensListAction?.({
      input: {},
      context: { surface: 'api', authority: 'account_automation' },
    })).resolves.toEqual({ tokens: [] });
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/account\/api-tokens\/list$/),
      {},
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer signed-daemon-account-token',
        }),
      }),
    );
  });

  it('routes a PAT Session Action through the selected API endpoint with the exact resolved Session target', async () => {
    const fetch = vi.fn<FetchLike>(async () => apiSuccess('session.status.get', {
      session: { id: exactSessionId, active: true },
    }));
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'cli', actionRequestId: 'request-1' },
    )).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: true } },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(new URL('v1/actions/session.status.get', configuration.apiServerUrl).toString());
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer hap_v1_token_secret' }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'session', sessionId: exactSessionId },
      input: { sessionId: exactSessionId },
    });
  });

  it('defers PAT Action execution until its prepared invocation runs', async () => {
    const fetch = vi.fn<FetchLike>(async () => apiSuccess('session.status.get', {
      session: { id: exactSessionId, active: true },
    }));
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    const prepared = await executor.prepare(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'cli' },
    );

    expect(prepared.kind).toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a runnable public Action invocation');

    const firstRun = prepared.invocation.run();
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: true } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });

  it('projects an API Action failure without falling back to the local executor', async () => {
    const fetch = vi.fn<FetchLike>(async () => apiFailure('session.status.get', 'target_unavailable', {
      retryAfterMs: 50,
    }));
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'target_unavailable',
      details: { retryAfterMs: 50 },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });

  it('rejects a non-public PAT Action before any local or HTTP execution', async () => {
    const fetch = vi.fn<FetchLike>();
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.handoff.commit',
      {},
      { surface: 'mcp' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported',
      error: 'unsupported',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
  });

  it('routes PAT-backed MCP Session Actions through the external adapter without local E2EE access', async () => {
    const fetch = vi.fn<FetchLike>(async () => apiSuccess('session.status.get', {
      session: { id: exactSessionId, active: false },
    }));
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'mcp', defaultSessionId: 'active-work' },
    )).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: false } },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'session', sessionId: exactSessionId },
      input: { sessionId: exactSessionId },
    });
  });

  it('projects PAT Session creation through the canonical public spawn binding', async () => {
    const fetch = vi.fn<FetchLike>(async () => apiSuccess('session.spawn_new', {
      type: 'success',
      sessionId: exactSessionId,
    }));
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.spawn_new',
      {
        creationKey: 'manual:pat-spawn-1',
        executionTarget: { serverId: 'daemon-profile-only', machineId: 'machine-selected' },
        directory: '/workspace/pat-project',
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: true,
      result: { type: 'success', sessionId: exactSessionId },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: expect.any(String),
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: {
        creationKey: 'manual:pat-spawn-1',
        directory: '/workspace/pat-project',
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
    });
  });

  it('surfaces transport failure instead of retrying through a local executor', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new Error('network unreachable');
    });
    vi.stubGlobal('fetch', fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'cli' },
    )).rejects.toThrow('network unreachable');

    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });
});

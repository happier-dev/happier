import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('./capabilities', () => ({ registerCapabilitiesHandlers: vi.fn() }));
vi.mock('./previewEnv', () => ({ registerPreviewEnvHandler: vi.fn() }));
vi.mock('./bash', () => ({ registerBashHandler: vi.fn() }));
vi.mock('./ripgrep', () => ({ registerRipgrepHandler: vi.fn() }));
vi.mock('./difftastic', () => ({ registerDifftasticHandler: vi.fn() }));
vi.mock('./daemonContributionRegistryProjection', () => ({ registerDaemonContributionRegistryProjectionHandler: vi.fn() }));
vi.mock('./spawnRuntimeSelection', () => ({
  readCanonicalSpawnRuntimeSelection: vi.fn(() => ({})),
  readSpawnRuntimeDescriptorV1: vi.fn(() => undefined),
}));
vi.mock('@/persistence', () => ({ readCredentials: vi.fn(async () => null) }));
vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: vi.fn(),
}));

async function loadRegisterSessionHandlers() {
  const module = await import('./registerSessionHandlers');
  return module.registerSessionHandlers;
}

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('registerSessionHandlers session controls', () => {
  it('routes goal RPCs to runtime goal controls and returns current work state', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const refreshGoal = vi.fn(async () => {});
    const setGoal = vi.fn(async () => {});
    const clearGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
        sessionWorkStateV1: workState,
      }) as Metadata & { sessionWorkStateV1: typeof workState },
      sessionRuntimeControls: {
        refreshGoal,
        setGoal,
        clearGoal,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
      objective: '  Ship native goal  ',
      status: 'paused',
      tokenBudget: 1200,
    })).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual({ workState });

    expect(refreshGoal).toHaveBeenCalledTimes(1);
    expect(setGoal).toHaveBeenCalledWith('Ship native goal', {
      status: 'paused',
      tokenBudget: 1200,
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });

  it('routes catalog and inline review RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const listVendorPlugins = vi.fn(async () => ({
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    }));
    const listSkills = vi.fn(async () => ({
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    }));
    const startInlineReview = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        listVendorPlugins,
        listSkills,
        startInlineReview,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    });

    const reviewRequest = {
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE)?.(reviewRequest)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(listVendorPlugins).toHaveBeenCalledWith({ cwd: '/override' });
    expect(listSkills).toHaveBeenCalledWith({ cwd: '/override' });
    expect(startInlineReview).toHaveBeenCalledWith(reviewRequest);
  });

  it('routes connected-service auth invalidation RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const invalidateConnectedServiceAuthTransports = vi.fn(async () => undefined);

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        invalidateConnectedServiceAuthTransports,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({ ok: true });

    expect(invalidateConnectedServiceAuthTransports).toHaveBeenCalledTimes(1);
  });

  it('routes usage-limit recovery RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => true,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'sess_1' });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'codex',
      resumePromptMode: 'off',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });

    expect(enableUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    });
    expect(cancelUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'codex',
      resumePromptMode: 'off',
    });
  });

  it('rejects whitespace-only usage-limit fingerprints before calling runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      status: 'malformed_response',
      errorCode: 'invalid_parameters',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      status: 'malformed_response',
      errorCode: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  it('fails closed when usage-limit recovery is disabled', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => false,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    const expected = {
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    };

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      rememberPreference: true,
    })).resolves.toEqual(expected);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    })).resolves.toEqual(expected);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    })).resolves.toEqual(expected);

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
  });

  it('returns unsupported when connected-service auth invalidation controls are unavailable', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
    });
  });

  it('persists usage-limit recovery intent through registered-field durable delivery when no runtime recovery hook is installed', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    let metadata: Metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
    };
    const enqueueRegisteredSessionStateFieldMutation = vi.fn(async (mutation: Parameters<typeof applyRegisteredSessionStateFieldMutationToMetadata>[1]) => {
      metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation);
    });

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => true,
      getSessionMetadata: () => metadata,
      enqueueRegisteredSessionStateFieldMutation,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });
    expect(metadata).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      },
    });
    expect(enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledTimes(1);

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'sess_1' });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'cancelled',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect(enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledTimes(2);
  });

  it('fails closed when neither runtime controls nor registered-field durable delivery are available', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => true,
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
      }) as Metadata,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
  });

  it('lets runtime message controls intercept provider-specific messages before enqueueing', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    const request = {
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(handleUserMessage).toHaveBeenCalledWith(request);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('sanitizes uploaded image metadata before runtime message controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const root = await mkdtemp(join(tmpdir(), 'happier-session-user-message-'));
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    try {
      const uploadedPath = '.happier/uploads/messages/m1/screen.png';
      const uploadedContent = Buffer.from('fake image bytes');
      const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
      await mkdir(join(root, '.happier', 'uploads', 'messages', 'm1'), { recursive: true });
      await writeFile(join(root, uploadedPath), uploadedContent);

      registerSessionHandlers(registrar, root, {
        enqueueSessionUserMessage,
        sessionRuntimeControls: {
          handleUserMessage,
        },
      });

      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
        text: 'inspect upload',
        localId: 'local-upload-image',
        meta: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [
                {
                  name: 'screen.png',
                  path: uploadedPath,
                  mimeType: 'image/png',
                  sizeBytes: uploadedContent.byteLength,
                  sha256,
                },
              ],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                localPath: uploadedPath,
                sha256,
                provenance: { kind: 'sessionAttachmentUpload' },
              },
              {
                kind: 'image',
                mimeType: 'image/png',
                localPath: '.happier/uploads/messages/m1/forged.png',
                sha256: '0'.repeat(64),
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      })).resolves.toEqual({ ok: true });

      expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            imageInputs: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
      expect(enqueueSessionUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            imageInputs: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

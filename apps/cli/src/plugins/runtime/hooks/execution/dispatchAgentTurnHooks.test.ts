import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import { logger } from '@/ui/logger';

import { transformAgentRequestThroughRuntimeRegistry } from './dispatchAgentTurnHooks';

function createAgentRequestRegistration(): ResolvedActivatedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'slow.plugin',
    manifestPath: '/plugins/slow.plugin/plugin.json',
    manifestDigest: 'sha256:slow.plugin',
    daemonEntryPath: '/plugins/slow.plugin/daemon.mjs',
    sourceSpec: {
      kind: 'path',
      locator: '/plugins/slow.plugin',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: 'agent.request.before',
      category: 'augmentation',
      scope: 'agent',
      executionKind: 'augment',
    },
  };
}

describe('agent turn hook dispatch bridge', () => {
  it('publishes agent-owned turn hook envelopes with agentId only', async () => {
    const registration = createAgentRequestRegistration();
    const handler = vi.fn(async (_envelope: unknown) => undefined);
    const runtimeRegistry = {
      readHookEventEnvelopeV1,
      hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
        ['agent.request.before', Object.freeze([
          {
            pluginId: registration.pluginId,
            hookId: 'agent.request.before',
            priority: 0,
            registrationIndex: 0,
            manifestPath: registration.manifestPath,
            manifestDigest: registration.manifestDigest,
            daemonEntryPath: registration.daemonEntryPath!,
            registration,
            handler,
          },
        ])],
      ]),
    };
    const originalPayload = {
      sessionId: 'session-1',
      agentId: 'codex',
      runtimeFamily: 'acpSession',
      method: 'session/prompt',
      request: {
        sessionId: 'provider-session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      },
      timestampMs: 1,
    };

    await transformAgentRequestThroughRuntimeRegistry(
      runtimeRegistry,
      originalPayload,
    );

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'agent.request.before',
      agentId: 'codex',
    }), expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    const envelope = handler.mock.calls[0]?.[0];
    expect(envelope).not.toHaveProperty('providerId');
    expect(envelope).not.toHaveProperty('backendId');
  });

  it('bounds transform handlers and falls back to the prior payload on timeout', async () => {
    vi.useFakeTimers();
    try {
      const registration = createAgentRequestRegistration();
      const runtimeRegistry = {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
          ['agent.request.before', Object.freeze([
            {
              pluginId: registration.pluginId,
              hookId: 'agent.request.before',
              priority: 0,
              registrationIndex: 0,
              manifestPath: registration.manifestPath,
              manifestDigest: registration.manifestDigest,
              daemonEntryPath: registration.daemonEntryPath!,
              exportName: 'transform',
              registration,
              handler: async () => await new Promise(() => undefined),
            },
          ])],
        ]),
      };
      const originalPayload = {
        sessionId: 'session-1',
        runtimeFamily: 'acpSession',
        method: 'session/prompt',
        request: {
          sessionId: 'provider-session-1',
          prompt: [{ type: 'text', text: 'hello' }],
        },
        timestampMs: 1,
      };

      const transformedPromise = transformAgentRequestThroughRuntimeRegistry(
        runtimeRegistry,
        originalPayload,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = await Promise.race([
        transformedPromise,
        Promise.resolve('pending'),
      ]);

      expect(settled).toEqual(originalPayload);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pass hostile hook-dispatch failures to retained logging', async () => {
    const privateTranscript = 'private streamed voice transcript that must not enter logs';
    const hostileFailure = {
      toJSON: () => ({ privateTranscript }),
      toString: () => privateTranscript,
    };
    const logDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const originalPayload = {
      sessionId: 'session-private-log-safety',
      agentId: 'codex',
      runtimeFamily: 'acpSession',
      method: 'session/prompt',
      request: {
        sessionId: 'provider-session-private-log-safety',
        prompt: [{ type: 'text', text: privateTranscript }],
      },
      timestampMs: 1,
    };

    try {
      await expect(transformAgentRequestThroughRuntimeRegistry({
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map(),
        activateContributionsOnDemand: async () => {
          throw hostileFailure;
        },
      }, originalPayload)).resolves.toEqual(originalPayload);

      expect(logDebug).toHaveBeenCalledWith(
        '[plugins] Plugin ACP request hook dispatch failed; using prior payload',
      );
    } finally {
      logDebug.mockRestore();
    }
  });
});

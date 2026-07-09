import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';
import type { PluginRuntimeHookHandler, ResolvedPluginHookHandler } from '../../types';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

function readPayload(event: unknown): Record<string, unknown> {
  return event && typeof event === 'object' && !Array.isArray(event) && 'payload' in event
    && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function createTransformHookRegistration(params: Readonly<{
  pluginId: string;
  hookId?: 'agent.context.before' | 'session.input.transform';
  priority?: number;
}>): ResolvedHookRegistration {
  const hookId = params.hookId ?? 'agent.context.before';
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    manifestDigest: `sha256:${params.pluginId}`,
    daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: hookId,
      category: 'augmentation',
      scope: hookId === 'session.input.transform' ? 'session' : 'agent',
      executionKind: 'augment',
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      handler: {
        target: 'plugin',
        exportName: 'transform',
      },
    },
  };
}

describe('dispatchPluginHookEvent transform hooks', () => {
  it('chains replacement payloads through handlers in deterministic order', async () => {
    const firstRegistration = createTransformHookRegistration({ pluginId: 'alpha.plugin', priority: 1 });
    const secondRegistration = createTransformHookRegistration({ pluginId: 'beta.plugin', priority: 2 });
    const firstHandlerMock = vi.fn(async (event: unknown) => {
      const payload = readPayload(event);
      return {
      ...payload,
      prompt: `${payload.prompt} [alpha]`,
      messages: [
        ...(payload.messages as readonly unknown[]),
        { role: 'system', content: 'alpha' },
      ],
      };
    });
    const firstHandler: PluginRuntimeHookHandler = firstHandlerMock;
    const secondHandlerMock = vi.fn(async (event: unknown) => {
      const payload = readPayload(event);
      return {
      ...payload,
      prompt: `${payload.prompt} [beta]`,
      messages: [
        ...(payload.messages as readonly unknown[]),
        { role: 'system', content: 'beta' },
      ],
      };
    });
    const secondHandler: PluginRuntimeHookHandler = secondHandlerMock;
    const observations: unknown[] = [];

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
          ['agent.context.before', Object.freeze([
            {
              pluginId: 'alpha.plugin',
              hookId: 'agent.context.before',
              priority: 1,
              registrationIndex: 0,
              manifestPath: firstRegistration.manifestPath,
              manifestDigest: firstRegistration.manifestDigest,
              daemonEntryPath: firstRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: firstRegistration,
              handler: firstHandler,
            },
            {
              pluginId: 'beta.plugin',
              hookId: 'agent.context.before',
              priority: 2,
              registrationIndex: 1,
              manifestPath: secondRegistration.manifestPath,
              manifestDigest: secondRegistration.manifestDigest,
              daemonEntryPath: secondRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: secondRegistration,
              handler: secondHandler,
            },
          ])],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.context.before',
        category: 'augmentation',
        scope: 'agent',
        happySessionId: 'session-1',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          sessionId: 'session-1',
          agentId: 'codex',
          runtimeFamily: 'hostSession',
          prompt: 'hello',
          messages: [{ role: 'user', content: 'hello' }],
          timestampMs: 1,
        },
      },
      publishHookObservation: async (record: unknown) => {
        observations.push(record);
      },
    });

    expect(firstHandlerMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        prompt: 'hello',
      },
    });
    expect(secondHandlerMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        prompt: 'hello [alpha]',
      },
    });
    expect(result).toMatchObject({
      eventId: 'agent.context.before',
      matchedHandlerCount: 2,
      aggregate: {
        executionKind: 'augment',
        result: {
          prompt: 'hello [alpha] [beta]',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'alpha' },
            { role: 'system', content: 'beta' },
          ],
        },
      },
    });
    expect(observations).toEqual([
      expect.objectContaining({ hookId: 'agent.context.before', pluginId: 'alpha.plugin', status: 'fulfilled' }),
      expect.objectContaining({ hookId: 'agent.context.before', pluginId: 'beta.plugin', status: 'fulfilled' }),
    ]);
  });

  it('keeps the prior payload when a transform returns an invalid replacement, rejects, or times out', async () => {
    const invalidRegistration = createTransformHookRegistration({ pluginId: 'invalid.plugin', hookId: 'session.input.transform', priority: 1 });
    const rejectingRegistration = createTransformHookRegistration({ pluginId: 'rejecting.plugin', hookId: 'session.input.transform', priority: 2 });
    const timedOutRegistration = createTransformHookRegistration({ pluginId: 'timeout.plugin', hookId: 'session.input.transform', priority: 3 });
    const finalRegistration = createTransformHookRegistration({ pluginId: 'final.plugin', hookId: 'session.input.transform', priority: 4 });
    const finalHandlerMock = vi.fn(async (event: unknown) => {
      const payload = readPayload(event);
      return {
        ...payload,
        text: `${payload.text} final`,
      };
    });
    const finalHandler: PluginRuntimeHookHandler = finalHandlerMock;
    const observations: unknown[] = [];

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
          ['session.input.transform', Object.freeze([
            {
              pluginId: 'invalid.plugin',
              hookId: 'session.input.transform',
              priority: 1,
              registrationIndex: 0,
              manifestPath: invalidRegistration.manifestPath,
              manifestDigest: invalidRegistration.manifestDigest,
              daemonEntryPath: invalidRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: invalidRegistration,
              handler: async () => ({ text: 'missing required session fields' }),
            },
            {
              pluginId: 'rejecting.plugin',
              hookId: 'session.input.transform',
              priority: 2,
              registrationIndex: 1,
              manifestPath: rejectingRegistration.manifestPath,
              manifestDigest: rejectingRegistration.manifestDigest,
              daemonEntryPath: rejectingRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: rejectingRegistration,
              handler: async () => {
                throw new Error('transform failed');
              },
            },
            {
              pluginId: 'timeout.plugin',
              hookId: 'session.input.transform',
              priority: 3,
              registrationIndex: 2,
              manifestPath: timedOutRegistration.manifestPath,
              manifestDigest: timedOutRegistration.manifestDigest,
              daemonEntryPath: timedOutRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: timedOutRegistration,
              handler: async () => await new Promise(() => undefined),
            },
            {
              pluginId: 'final.plugin',
              hookId: 'session.input.transform',
              priority: 4,
              registrationIndex: 3,
              manifestPath: finalRegistration.manifestPath,
              manifestDigest: finalRegistration.manifestDigest,
              daemonEntryPath: finalRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: finalRegistration,
              handler: finalHandler,
            },
          ])],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'session.input.transform',
        category: 'augmentation',
        scope: 'session',
        happySessionId: 'session-1',
        timestampMs: 1,
        payload: {
          sessionId: 'session-1',
          localId: 'local-1',
          text: 'original',
          meta: { source: 'ui' },
          timestampMs: 1,
        },
      },
      handlerTimeoutMs: 1,
      publishHookObservation: async (record: unknown) => {
        observations.push(record);
      },
    });

    expect(finalHandlerMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        text: 'original',
      },
    });
    expect(result).toMatchObject({
      eventId: 'session.input.transform',
      matchedHandlerCount: 4,
      aggregate: {
        executionKind: 'augment',
        result: {
          sessionId: 'session-1',
          localId: 'local-1',
          text: 'original final',
        },
      },
      outcomes: [
        expect.objectContaining({ pluginId: 'invalid.plugin', status: 'rejected' }),
        expect.objectContaining({ pluginId: 'rejecting.plugin', status: 'rejected', error: 'transform failed' }),
        expect.objectContaining({ pluginId: 'timeout.plugin', status: 'rejected', error: expect.stringContaining('timed out') }),
        expect.objectContaining({ pluginId: 'final.plugin', status: 'fulfilled' }),
      ],
    });
    expect(observations).toEqual([
      expect.objectContaining({ pluginId: 'invalid.plugin', status: 'rejected' }),
      expect.objectContaining({ pluginId: 'rejecting.plugin', status: 'rejected' }),
      expect.objectContaining({ pluginId: 'timeout.plugin', status: 'rejected' }),
      expect.objectContaining({ pluginId: 'final.plugin', status: 'fulfilled' }),
    ]);
  });
});

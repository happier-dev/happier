import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
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
}>): ResolvedActivatedHookRegistration {
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

  it('rolls back a valid transform prefix and stops after an invalid replacement', async () => {
    const firstRegistration = createTransformHookRegistration({ pluginId: 'first.plugin', hookId: 'session.input.transform', priority: 1 });
    const invalidRegistration = createTransformHookRegistration({ pluginId: 'invalid.plugin', hookId: 'session.input.transform', priority: 2 });
    const laterRegistration = createTransformHookRegistration({ pluginId: 'later.plugin', hookId: 'session.input.transform', priority: 3 });
    const laterHandler = vi.fn(async (event: unknown) => ({
      ...readPayload(event),
      text: 'must not run',
    }));
    const resolved = (
      registration: ResolvedActivatedHookRegistration,
      registrationIndex: number,
      handler: ResolvedPluginHookHandler['handler'],
    ): ResolvedPluginHookHandler => ({
      pluginId: registration.pluginId,
      hookId: 'session.input.transform',
      priority: registration.definition.priority ?? 0,
      registrationIndex,
      manifestPath: registration.manifestPath,
      manifestDigest: registration.manifestDigest,
      daemonEntryPath: registration.daemonEntryPath!,
      registration,
      handler,
    });

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([['session.input.transform', Object.freeze([
          resolved(firstRegistration, 0, async (event) => ({
            ...readPayload(event),
            text: 'valid prefix',
          })),
          resolved(invalidRegistration, 1, async () => ({ text: 'missing required subject' })),
          resolved(laterRegistration, 2, laterHandler),
        ])]]),
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
    });

    expect(laterHandler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      matchedHandlerCount: 2,
      outcomes: [
        expect.objectContaining({ pluginId: 'first.plugin', status: 'fulfilled' }),
        expect.objectContaining({ pluginId: 'invalid.plugin', status: 'rejected' }),
      ],
      aggregate: {
        executionKind: 'augment',
        result: {
          sessionId: 'session-1',
          localId: 'local-1',
          text: 'original',
          meta: { source: 'ui' },
          timestampMs: 1,
        },
      },
    });
  });

  it('rolls back immediately when the first transform throws', async () => {
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
              pluginId: 'rejecting.plugin',
              hookId: 'session.input.transform',
              priority: 1,
              registrationIndex: 0,
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
              pluginId: 'invalid.plugin',
              hookId: 'session.input.transform',
              priority: 2,
              registrationIndex: 1,
              manifestPath: invalidRegistration.manifestPath,
              manifestDigest: invalidRegistration.manifestDigest,
              daemonEntryPath: invalidRegistration.daemonEntryPath!,
              exportName: 'transform',
              registration: invalidRegistration,
              handler: async () => ({ text: 'missing required session fields' }),
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

    expect(finalHandlerMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      eventId: 'session.input.transform',
      matchedHandlerCount: 1,
      aggregate: {
        executionKind: 'augment',
        result: {
          sessionId: 'session-1',
          localId: 'local-1',
          text: 'original',
        },
      },
      outcomes: [
        expect.objectContaining({ pluginId: 'rejecting.plugin', status: 'rejected', error: 'plugin_hook_handler_failed' }),
      ],
    });
    expect(observations).toEqual([
      expect.objectContaining({ pluginId: 'rejecting.plugin', status: 'rejected' }),
    ]);
  });
});

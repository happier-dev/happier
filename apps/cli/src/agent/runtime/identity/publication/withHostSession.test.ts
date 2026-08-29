import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  HOST_SESSION_RUNTIME_PLAN_KIND,
  type HostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/lifecycle';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { applySessionStateUpdatesToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { withHostSessionRuntimeIdentityPublication } from './withHostSession';
import { subscribeSessionRuntimePublicationToMetadata } from '../metadata/subscription';

function createRuntimeTurnOperations(
  overrides: Partial<RuntimeTurnOperations> = {},
): RuntimeTurnOperations {
  return {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: null })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('withHostSessionRuntimeIdentityPublication', () => {
  it('adds the host runtime descriptor to initial session metadata while preserving provider augmentation', () => {
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'antigravity',
      opts: {},
      config: {
        augmentSessionMetadata: (metadata: Record<string, unknown>) => ({
          ...metadata,
          providerAugmented: true,
        }),
        createSessionRuntime: vi.fn(async () => ({ operations: createRuntimeTurnOperations() })),
      },
    } as unknown as HostSessionRuntimePlan;
    const runtimeDescriptor = {
      v: 1,
      agentId: 'antigravity',
      agent: {
        backendMode: 'localharness',
        agentExtra: {
          owner: 'happier',
          schemaId: 'happier.hostSessionRuntimeIdentity',
          v: 1,
          runtimeHandle: {
            backendId: 'antigravity-localharness',
            agentId: 'antigravity',
            provenance: 'first_party',
          },
        },
      },
    } as const;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });

    const metadata = wrapped.config.augmentSessionMetadata?.({
      path: '/repo',
      flavor: 'antigravity-localharness',
    } as never);

    expect(metadata).toEqual(expect.objectContaining({
      path: '/repo',
      flavor: 'antigravity-localharness',
      providerAugmented: true,
      runtimeDescriptorV1: runtimeDescriptor,
    }));
    expect(metadata).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('preserves user message seq metadata when forwarding normal prompt sends', async () => {
    const sendTurnPrompt = vi.fn(async () => undefined);
    const runtime = createRuntimeTurnOperations({ sendTurnPrompt });
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'codex',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({ operations: runtime })),
      },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });

    const created = await wrapped.config.createSessionRuntime?.({} as never);
    await created?.operations.sendTurnPrompt('resume prompt', { userMessageSeq: 92 });

    expect(sendTurnPrompt).toHaveBeenCalledWith('resume prompt', { userMessageSeq: 92 });
  });

  it('preserves the explicit terminal mode binding alongside runtime publication decoration', async () => {
    const runtime = createRuntimeTurnOperations();
    const terminalRemoteModeLoop = {
      startingMode: 'remote' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit' as const, code: 0 })),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'antigravity',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({
          operations: runtime,
          terminalRemoteModeLoop,
        })),
      },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });

    const created = await wrapped.config.createSessionRuntime?.({} as never);

    expect(created?.terminalRemoteModeLoop).toBe(terminalRemoteModeLoop);
    expect(
      (created?.operations as unknown as Readonly<Record<string, unknown>>)
        ?.resolveTerminalRemoteSessionModeLoop,
    ).toBeUndefined();
  });

  it('publishes an Agent-resolved descriptor before exposing the runtime and keeps it as the fallback event identity', async () => {
    const hostDescriptor = {
      v: 1,
      agentId: 'claude',
      agent: { backendMode: 'host-generic' },
    } as const;
    const agentDescriptor = {
      v: 1,
      agentId: 'claude',
      agent: { backendMode: 'native', configDir: '/tmp/claude-config' },
    } as const;
    let metadata: Record<string, unknown> = {
      runtimeDescriptorV1: hostDescriptor,
    };
    const updateMetadata = vi.fn(async (
      updater: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      metadata = updater(metadata);
    });
    const runtime = createRuntimeTurnOperations();
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'claude',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({
          operations: runtime,
          runtimeDescriptorV1: agentDescriptor,
        })),
      },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: hostDescriptor,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });

    const created = await wrapped.config.createSessionRuntime?.({
      session: { updateMetadata },
    } as never);

    expect(updateMetadata).toHaveBeenCalledOnce();
    expect(metadata.runtimeDescriptorV1).toEqual(agentDescriptor);

    const messages: unknown[] = [];
    const unsubscribe = created?.operations.subscribeRuntimeEvents((message) => {
      messages.push(message);
    });
    unsubscribe?.();

    expect(messages).toContainEqual({
      type: 'event',
      name: 'runtime.descriptor',
      payload: agentDescriptor,
    });
  });

  it('publishes live capability facts supplied by an external Agent Session runtime', async () => {
    const runtimeCapabilities = {
      sessionCapabilities: {
        sessionFork: {
          conversation: 'supported' as const,
          fromMessage: 'unsupported' as const,
        },
      },
    };
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'acme.agent',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({
          operations: createRuntimeTurnOperations(),
          runtimeCapabilities,
        })),
      },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: {
          backend: { sessions: { supported: true } },
        },
        runtimeFacets: null,
      },
    });
    const created = await wrapped.config.createSessionRuntime?.({} as never);
    const messages: unknown[] = [];
    created?.operations.subscribeRuntimeEvents((message) => messages.push(message));

    expect(messages).toContainEqual({
      type: 'event',
      name: 'runtime.capabilities',
      payload: {
        backend: { sessions: { supported: true } },
        ...runtimeCapabilities,
      },
    });
  });

  it('does not publish an Agent descriptor when opening the runtime fails', async () => {
    const updateMetadata = vi.fn(async () => undefined);
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'claude',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => {
          throw new Error('open failed');
        }),
      },
    } as unknown as HostSessionRuntimePlan;
    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: {
          v: 1,
          agentId: 'claude',
          agent: { backendMode: 'host-generic' },
        },
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });

    await expect(wrapped.config.createSessionRuntime?.({
      session: { updateMetadata },
    } as never)).rejects.toThrow('open failed');

    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps the Agent-owned fallback descriptor opaque when generic Session identity changes', async () => {
    let providerSessionId: string | null = null;
    const runtime = createRuntimeTurnOperations({
      sendTurnPrompt: vi.fn(async () => {
        providerSessionId = 'vendor-session-1';
      }),
      readSessionIdentity: vi.fn(() => ({ sessionId: providerSessionId })),
    });
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'codex',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({ operations: runtime })),
      },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            agentExtra: {
              owner: 'happier',
              schemaId: 'happier.hostSessionRuntimeIdentity',
              v: 1,
              runtimeHandle: {
                backendId: 'codex.appServer',
                agentId: 'codex',
                provenance: 'first_party',
              },
            },
          },
        },
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });
    const created = await wrapped.config.createSessionRuntime?.({} as never);
    const messages: unknown[] = [];
    const unsubscribe = created?.operations.subscribeRuntimeEvents((message) => {
      messages.push(message);
    });

    expect(messages).toContainEqual({
      type: 'event',
      name: 'runtime.descriptor',
      payload: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          agentExtra: {
            owner: 'happier',
            schemaId: 'happier.hostSessionRuntimeIdentity',
            v: 1,
            runtimeHandle: {
              backendId: 'codex.appServer',
              agentId: 'codex',
              provenance: 'first_party',
            },
          },
        },
      },
    });

    await created?.operations.sendTurnPrompt('hello');
    unsubscribe?.();

    expect(messages).not.toContainEqual({
      type: 'event',
      name: 'runtime.descriptor',
      payload: expect.objectContaining({
        agent: expect.objectContaining({
          providerSessionId: 'vendor-session-1',
        }),
      }),
    });
    expect(messages.filter((message) => (
      Boolean(message)
      && typeof message === 'object'
      && (message as Readonly<Record<string, unknown>>).type === 'event'
      && (message as Readonly<Record<string, unknown>>).name === 'runtime.descriptor'
    ))).toHaveLength(1);
  });

  it('does not overwrite an upstream-authoritative descriptor with fallback refreshes', async () => {
    const upstreamDescriptor = {
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'upstream-session-1',
      },
    } as const;
    const runtime = createRuntimeTurnOperations({
      sendTurnPrompt: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: 'fallback-session-1' })),
      subscribeRuntimeEvents: vi.fn((handler) => {
        handler({
          type: 'event',
          name: 'runtime.descriptor',
          payload: upstreamDescriptor,
        });
        return () => undefined;
      }),
    });
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'codex',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({ operations: runtime })),
      },
    } as unknown as HostSessionRuntimePlan;
    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'fallback',
          },
        },
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });
    const created = await wrapped.config.createSessionRuntime?.({} as never);
    const messages: unknown[] = [];
    const unsubscribe = created?.operations.subscribeRuntimeEvents((message) => {
      messages.push(message);
    });

    await created?.operations.sendTurnPrompt('hello');
    unsubscribe?.();

    expect(messages).toEqual([{
      type: 'event',
      name: 'runtime.descriptor',
      payload: upstreamDescriptor,
    }]);
  });

  it('persists RuntimeEvent descriptor updates through normalized host-session publication', async () => {
    const upstreamRuntimeEvents: { handler?: (message: unknown) => void } = {};
    const runtime = createRuntimeTurnOperations({
      subscribeRuntimeEvents: vi.fn((handler) => {
        upstreamRuntimeEvents.handler = handler;
        return () => {
          if (upstreamRuntimeEvents.handler === handler) {
            delete upstreamRuntimeEvents.handler;
          }
        };
      }),
    });
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'antigravity',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({ operations: runtime })),
      },
    } as unknown as HostSessionRuntimePlan;
    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });
    const created = await wrapped.config.createSessionRuntime?.({} as never);
    if (!created) {
      throw new Error('expected wrapped runtime');
    }
    const session = {
      sessionId: 'session-1',
      updateMetadata: vi.fn(),
    };
    const sessionState = {
      writeHappierField: vi.fn(async () => ({ ok: true as const, version: 1 })),
    };
    const descriptor = {
      v: 1,
      agentId: 'antigravity',
      agent: {
        runtimeMode: 'cliPrint',
        agyConversationId: 'agy-conversation-1',
      },
    } as const;
    const unsubscribe = subscribeSessionRuntimePublicationToMetadata({
      session,
      sessionState,
      runtime: created.operations,
    } as never);

    const publishRuntimeMessage = upstreamRuntimeEvents.handler;
    if (!publishRuntimeMessage) {
      throw new Error('expected runtime event subscription');
    }
    publishRuntimeMessage({
      type: 'event',
      name: 'runtime.descriptor',
      payload: descriptor,
    });
    unsubscribe();

    expect(sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.runtimeDescriptor',
      value: descriptor,
      reason: 'reconciliation',
      metadataReason: 'runtime-identity-publication',
    });
    expect(session.updateMetadata).not.toHaveBeenCalled();
  });

  it('preserves dynamic permission response capability after startup', async () => {
    let started = false;
    const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
    const runtime = createRuntimeTurnOperations({
      sendTurnPrompt: vi.fn(async () => {
        started = true;
      }),
    });
    Object.defineProperties(runtime, {
      permissionCapability: {
        get() {
          return started ? 'responds' as const : undefined;
        },
      },
      respondToPermission: {
        get() {
          return started ? respondToPermission : undefined;
        },
      },
    });
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'codex',
      opts: {},
      config: {
        createSessionRuntime: vi.fn(async () => ({ operations: runtime })),
      },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });

    const created = await wrapped.config.createSessionRuntime?.({} as never);

    expect(created?.operations.permissionCapability).toBeUndefined();
    expect(created?.operations.respondToPermission).toBeUndefined();
    await created?.operations.sendTurnPrompt('hello');
    expect(created?.operations.permissionCapability).toBe('responds');
    expect(created?.operations.respondToPermission).toBeTypeOf('function');
    await expect(created?.operations.respondToPermission?.('permission-1', true)).resolves.toEqual({ delivered: true });
    expect(respondToPermission).toHaveBeenCalledWith('permission-1', true);
  });
});

/**
 * The whole external-Agent resume vertical, composed from its real parts.
 *
 * An external (manifest-contributed) Agent has no generated `<vendor>SessionId`
 * slot, so the host resolves no `providerSessionMetadataKey` for it. Its native
 * conversation id therefore has to travel the agent-agnostic route end to end:
 * the public `provider-session-id` event -> the session-state binding -> the
 * runtime-descriptor metadata slot -> `resolveVendorResumeIdFromSessionMetadata`,
 * which is what the daemon's spawn/respawn path asks for a resume id.
 *
 * Break any link and the daemon derives no resume id while the catalog still
 * reports `vendorResumeSupport: 'supported'`, so a declared resume silently
 * starts a NEW provider conversation.
 */
describe('external Agent native resume identity — composed host publication', () => {
  const externalHostDescriptor = {
    v: 1,
    agentId: 'acme',
    agent: {
      backendMode: 'custom',
      agentExtra: {
        owner: 'happier',
        schemaId: 'happier.hostSessionRuntimeIdentity',
        v: 1,
        runtimeHandle: {
          backendId: 'acme',
          agentId: 'acme',
          provenance: 'external',
        },
      },
    },
  } as const;

  async function runExternalAgentSession(): Promise<Record<string, unknown>> {
    const upstream: { handler?: (message: unknown) => void } = {};
    const runtime = createRuntimeTurnOperations({
      // This Agent reports its native id ONLY through the public event, the way
      // the SDK documents it.
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      subscribeRuntimeEvents: vi.fn((handler) => {
        upstream.handler = handler as (message: unknown) => void;
        return () => { delete upstream.handler; };
      }),
    });
    const plan = {
      kind: HOST_SESSION_RUNTIME_PLAN_KIND,
      agentId: 'acme',
      opts: {},
      config: { createSessionRuntime: vi.fn(async () => ({ operations: runtime })) },
    } as unknown as HostSessionRuntimePlan;

    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan,
      identity: {
        runtimeDescriptor: externalHostDescriptor,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
    });
    const created = await wrapped.config.createSessionRuntime?.({} as never);
    if (!created) throw new Error('expected wrapped runtime');

    let metadata: Record<string, unknown> = {};
    const sessionState = {
      writeHappierField: vi.fn(async (input: { fieldId: string; value: unknown }) => {
        metadata = applySessionStateUpdatesToMetadata(metadata as never, [
          { fieldId: input.fieldId, value: input.value } as never,
        ]) as never;
        return { ok: true as const, version: 1 };
      }),
    };
    subscribeSessionRuntimePublicationToMetadata({
      session: { sessionId: 'session-1', updateMetadata: vi.fn() },
      sessionState,
      runtime: created.operations,
      // No catalog-declared flat slot exists for an external Agent.
      providerSessionMetadataKey: null,
    } as never);

    upstream.handler?.({
      kind: 'provider-session-id',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      providerSessionId: 'acme-native-1',
    });
    await Promise.resolve();
    await Promise.resolve();
    return metadata;
  }

  it('carries the native id from the public event to the daemon resume-id reader', async () => {
    const metadata = await runExternalAgentSession();

    const publishedDescriptor = readRuntimeDescriptorV1FromMetadata(metadata);
    expect(publishedDescriptor).toMatchObject({ agentId: 'acme' });
    expect(publishedDescriptor?.agent).not.toHaveProperty('providerSessionId');
    expect(metadata.nativeResumeIdentityV1).toEqual({
      v: 1,
      vendorResumeId: 'acme-native-1',
    });
    expect(resolveVendorResumeIdFromSessionMetadata('acme' as never, metadata))
      .toBe('acme-native-1');
  });

  it('never lends the recorded id to a different Agent', async () => {
    const metadata = await runExternalAgentSession();

    expect(resolveVendorResumeIdFromSessionMetadata('other' as never, metadata))
      .toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { resetVoiceQaStoreForTests, useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import {
  createBundledConversationRuntimeHostLease,
  type BundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import {
  type BundledConversationRuntimeEntry,
  BundledConversationRuntimeCompositionError,
  createBundledConversationRuntimes,
  isBundledHostedConversationEntryAuthorized,
  requestBundledVoiceAccountOperationWithRouteFence,
} from './bundledConversationRuntimes';

function createDeferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function createPublicEntry(input: Readonly<{
  providerId: string;
  activateError?: Error;
  dispose?: () => Promise<void>;
}>): BundledConversationRuntimeEntry {
  const localId = input.providerId.replaceAll('_', '-');
  const declaration = Object.freeze({
    id: localId,
    title: input.providerId,
    kind: 'conversation' as const,
    roles: ['realtime_conversation' as const],
    platforms: ['web' as const],
    capabilities: Object.freeze({
      readiness: Object.freeze({ requirements: [] }),
      turn: Object.freeze({ cancelResponse: false, bargeIn: false }),
    }),
    client: Object.freeze({
      artifactId: 'voice-runtime',
      modulePath: './voiceRuntime',
      exportName: 'activate' as const,
    }),
  });
  return Object.freeze({
    uiEntry: Object.freeze({
      kind: 'voice.conversation-provider.v1' as const,
      pluginId: 'test.voice',
      providerId: input.providerId,
      declaration,
      settingsSectionId: `voice.provider.${input.providerId}`,
      roles: declaration.roles,
      requirements: declaration.capabilities.readiness.requirements,
      supportedPlatforms: declaration.platforms,
      selectionOptions: Object.freeze([]),
      internal: Object.freeze({
        resolveSurfaceCapabilities: () => Object.freeze({
          allowsGlobalStart: true,
          controlSessionScope: 'global' as const,
          requiresVoiceAgentFeature: false,
          bargeInEnabled: false,
          cancelResponse: 'unsupported' as const,
          interruptionPolicy: 'disabled' as const,
        }),
      }),
    }),
    activate(api: Pick<PluginApi, 'voiceProviders'>) {
      if (input.activateError) throw input.activateError;
      api.voiceProviders.register(localId, Object.freeze({
        protocol: Object.freeze({
          prepare: async () => Object.freeze({ kind: 'declined' as const, code: 'test' }),
          decodeControl: () => [],
          encodeTurnControl: () => null,
        }),
        createConnection: async () => { throw new Error('not_used'); },
        encodeToolResults: () => [],
        encodeToolContinuation: () => Object.freeze({}),
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
        ...(input.dispose ? { dispose: input.dispose } : {}),
      }));
    },
  });
}

describe('createBundledConversationRuntimes', () => {
  const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
  const originalDev = (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;

  afterEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = originalDebug;
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = originalDev;
    resetVoiceQaStoreForTests();
  });

  it('classifies a missing global Agent account binding as authentication-required', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();

    await expect(hostLease.host.resolveAgentRealtimeVoiceConversationBinding({
      provider: { pluginId: 'happier.voice.codex', localId: 'realtime-codex' },
      agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
      controlSessionId: hostLease.host.globalVoiceSessionId,
      requestedTargetSessionId: null,
      settings: {},
    })).rejects.toMatchObject({
      code: 'authentication_required',
      message: 'voice_global_connected_service_binding_required',
    });

    hostLease.revoke();
  });

  it('does not mutate Voice QA diagnostics in a production runtime', () => {
    process.env.EXPO_PUBLIC_DEBUG = '0';
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
    resetVoiceQaStoreForTests();
    useVoiceQaStore.getState().begin('realtime_conversation', 'qa-session');
    const initialState = useVoiceQaStore.getState();
    const hostLease = createBundledConversationRuntimeHostLease();

    hostLease.host.diagnostics?.appendSystem('connected');
    hostLease.host.diagnostics?.appendProviderEvent({
      providerId: 'realtime_elevenlabs',
      eventType: 'user_transcript',
      payloadBytes: null,
      redactionClass: 'transcript_redacted',
    });
    hostLease.host.diagnostics?.appendError('disconnected');

    expect(useVoiceQaStore.getState()).toBe(initialState);
    hostLease.revoke();
  });

  it('retains Voice QA diagnostics in a debug runtime', () => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
    resetVoiceQaStoreForTests();
    useVoiceQaStore.getState().begin('realtime_conversation', 'qa-session');
    const hostLease = createBundledConversationRuntimeHostLease();

    hostLease.host.diagnostics?.appendSystem('connected');
    hostLease.host.diagnostics?.appendProviderEvent({
      providerId: 'realtime_elevenlabs',
      eventType: 'user_transcript',
      payloadBytes: null,
      redactionClass: 'transcript_redacted',
    });
    hostLease.host.diagnostics?.appendError('disconnected');

    expect(useVoiceQaStore.getState().entries.map((entry) => entry.kind)).toEqual([
      'system',
      'provider.event',
      'error',
    ]);
    hostLease.revoke();
  });

  it('exposes an awaitable cleanup barrier when later factory composition fails', async () => {
    const cleanupGate = createDeferred();
    let cleanupFinished = false;
    const hostLease = createBundledConversationRuntimeHostLease();
    const validEntry = createPublicEntry({
      providerId: 'first_provider',
      async dispose() {
        await cleanupGate.promise;
        cleanupFinished = true;
      },
    });
    const throwingEntry = createPublicEntry({
      providerId: 'second_provider',
      activateError: new Error('factory_failed'),
    });

    let compositionError: unknown;
    try {
      createBundledConversationRuntimes({ bundledEntries: [validEntry, throwingEntry], host: hostLease.host });
    } catch (error) {
      compositionError = error;
    }

    expect(compositionError).toBeInstanceOf(BundledConversationRuntimeCompositionError);
    expect(cleanupFinished).toBe(false);
    cleanupGate.resolve();
    await (compositionError as BundledConversationRuntimeCompositionError).cleanup;
    expect(cleanupFinished).toBe(true);
    hostLease.revoke();
  });

  it('authorizes hosted conversation only by exact generated entry identity', () => {
    const trusted = createPublicEntry({ providerId: 'realtime_elevenlabs' });
    const collidingCopy = Object.freeze({
      ...trusted,
      uiEntry: Object.freeze({ ...trusted.uiEntry }),
    });

    expect(isBundledHostedConversationEntryAuthorized(trusted, [trusted])).toBe(true);
    expect(isBundledHostedConversationEntryAuthorized(collidingCopy, [trusted])).toBe(false);
  });

  it.each([
    [
      { kind: 'daemonAction' as const, actionLocalId: 'mint-realtime-client-auth-with-codex-oauth' },
      { kind: 'daemonAction' as const, actionLocalId: 'mint-realtime-client-auth' },
    ],
    [
      { kind: 'daemonAction' as const, actionLocalId: 'mint-realtime-client-auth-with-codex-oauth' },
      { kind: 'savedSecret' as const },
    ],
    [
      { kind: 'savedSecret' as const },
      { kind: 'daemonAction' as const, actionLocalId: 'mint-realtime-client-auth-with-codex-oauth' },
    ],
  ])('rejects an in-flight account operation after its authentication route changes', async (
    initialRoute,
    replacementRoute,
  ) => {
    const deferred = createDeferred();
    let route = initialRoute;
    const operation = requestBundledVoiceAccountOperationWithRouteFence({
      isCurrent: () => true,
      readRoute: () => route,
      async request() {
        await deferred.promise;
        return {
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: {},
          body: new TextEncoder().encode(JSON.stringify({
            value: 'stale-ephemeral-artifact',
            expires_at: 2_000_000_000,
          })),
        };
      },
    });

    route = replacementRoute;
    deferred.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'voice_account_operation_cancelled',
    });
  });

  it.each([
    'credential_unavailable',
    'credential_access_review_required',
  ])('preserves %s without trying another credential route', async (code) => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error(code), { code });
    });

    await expect(requestBundledVoiceAccountOperationWithRouteFence({
      isCurrent: () => true,
      readRoute: () => ({ kind: 'savedSecret' }),
      request,
    })).rejects.toMatchObject({ code, message: code });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

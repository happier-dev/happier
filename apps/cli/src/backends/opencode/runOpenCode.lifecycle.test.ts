import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { resolveOpenCodeProviderAttachTargetWithManagedServerFallback } from './attach/evaluateOpenCodeProviderAttachEligibility';
import { createOpenCodeProviderConfig } from './runOpenCode';
import { createManagedOpenCodeClientFixture, createOpenCodeSseResponse } from './server/managedOpenCodeClient.testkit';
import { readOpenCodeSessionRuntimeHandleFromMetadata } from './utils/opencodeSessionAffinity';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('OpenCode runner lifecycle affinity', () => {
  it('publishes the selected managed affinity again after resetting and restarting the same runtime', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    const streams: ReturnType<typeof createOpenCodeSseResponse>[] = [];
    let sessionsCreated = 0;
    // The provider HTTP boundary is substituted; runtime, client, state selection and publication stay real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/global/health') return Response.json({ healthy: true, version: '1.18.33' });
      if (url.pathname === '/session' && init?.method === 'POST') {
        return Response.json({ id: `ses_restart_${++sessionsCreated}` });
      }
      if (url.pathname === '/event') {
        const stream = createOpenCodeSseResponse(init?.signal);
        streams.push(stream);
        stream.send({ type: 'server.connected', properties: {} });
        return stream.response;
      }
      if (url.pathname === '/mcp') return Response.json({ happier: { status: 'connected' } });
      if (url.pathname === '/config') return Response.json({});
      return Response.json([]);
    });
    const session = createMutableApiSessionClientFixture({
      metadata: createTestMetadata({ flavor: 'opencode', path: fixture.homeDir }),
      overrides: {
        sendSessionEvent: () => {},
        updateAgentState: async () => {},
        materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' }),
      },
    });
    session.ensureMetadataSnapshot = async () => session.getMetadataSnapshot();
    const config = createOpenCodeProviderConfig({
      credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      startedBy: 'daemon',
    });
    const consumer = createSessionProviderInputConsumer({
      session, messageQueue: new MessageQueue2<unknown, unknown>(() => 'fixture'),
    });
    const runtime = config.createRuntime({
      directory: fixture.homeDir, metadata: session.getMetadataSnapshot()!, machineId: 'fixture-machine', session,
      messageBuffer: new MessageBuffer(), mcpServers: {},
      permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[affinity-test]' }),
      getPermissionMode: () => 'default', getAbortSignal: () => new AbortController().signal,
      setThinking: () => {}, memoryRecallGuidanceEnabled: false, toolDelivery: 'native_mcp',
      processEnv: { ...process.env, HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0' },
      providerInputConsumer: consumer, turnAssistantPreviewTracker: createTurnAssistantPreviewTracker(),
    });
    try {
      // A second session keeps the shared server alive across this runner's reset.
      await fixture.createClient({ directory: fixture.homeDir, messageBuffer: new MessageBuffer() });
      const selected = await fixture.publish();
      for (let start = 1; start <= 3; start += 1) {
        await runtime.startOrLoad({});
        await config.onAfterStart?.({ session, runtime, initialControlsApplied: true, prepareLocalAttachment: async () => true });
        await vi.waitFor(() => expect(readOpenCodeSessionRuntimeHandleFromMetadata(session.getMetadataSnapshot()).vendorSessionId)
          .toBe(`ses_restart_${start}`));
        expect(readOpenCodeSessionRuntimeHandleFromMetadata(session.getMetadataSnapshot()).managedServerLaunchFingerprint)
          .toBe(selected.launchEnvFingerprint);

        // Standalone attach must use persisted affinity even under another shell's launch context.
        const previousAuth = process.env.OPENCODE_AUTH_CONTENT;
        process.env.OPENCODE_AUTH_CONTENT = 'another-account';
        try {
          await expect(resolveOpenCodeProviderAttachTargetWithManagedServerFallback({ metadata: session.getMetadataSnapshot()! }))
            .resolves.toMatchObject({ eligible: true, baseUrl: selected.baseUrl,
              managedServerLaunchFingerprint: selected.launchEnvFingerprint });
        } finally {
          if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
          else process.env.OPENCODE_AUTH_CONTENT = previousAuth;
        }
        await runtime.reset();
        await config.onAfterReset?.({ session, runtime });
      }
    } finally {
      await runtime.reset();
      await config.onDispose?.({ session, runtime });
      for (const stream of streams) stream.close();
      await consumer.closeProviderInputAdmissionAndWaitForDispatches();
      await fixture.close();
    }
  });
});

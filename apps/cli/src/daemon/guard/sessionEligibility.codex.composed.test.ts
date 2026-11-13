import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import axios from 'axios';
import { openCodexNativeAppServerSession } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInvocationLogger } from '@/plugins/runtime/invocation/services/logger';
import { createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
  createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { buildInactiveSessionResumeSpawnOptions } from '../sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { prepareExecuteSpawnSessionRequest } from '../startup/prepareExecuteSpawnSessionRequest';
import { evaluateSessionEligibility } from './sessionEligibility';
import type { TrackedSession } from '../types';
import { sessionStop } from './actuators/sessionStop';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => {
  try { await fixture?.dispose(); }
  finally { await pluginReloadController.shutdown(); }
});

it.skipIf(process.platform === 'win32')('persists fresh Codex native identity, admits automatic stop, and answers the next input after inactive admission', async () => {
    await withCodexNativeAttachFixture(async ({ exec, directory }) => {
      const sessionId = 'codex-resume-proof';
      const credentials = { token: 'codex-resume-proof', encryption: null };
      const resolution = await resolveBackendEngineAdapterResolution('codex', { runtimeRegistry: fixture.registry });
      const lease = fixture.registry.agentRuntimesByAgentId.get('codex');
      if (!resolution || !lease) throw new Error('Admitted Codex declaration unavailable');
      const services = { ...createUnavailablePluginServices(), exec,
        logger: createPluginInvocationLogger({
          seed: { plugin: { id: lease.pluginId, version: lease.pluginVersion },
            contribution: { id: 'codex', qualifiedId: `${lease.pluginId}/agents/codex` },
            occurrenceId: lease.occurrenceId, correlationId: sessionId, surface: 'agent',
            signal: lease.retirementSignal, isOccurrenceCurrent: lease.isCurrent },
          // Log output is an IO boundary; retain the real invocation logger.
          sink: { write() {} },
        }),
      };
      const session = createNativeSessionClientTestPort(sessionId);
      await session.updateMetadata(metadata => ({ ...metadata, path: directory, machineId: 'machine-1', flavor: 'codex' }));
      const nativePlan = await createNativeAgentRuntimeSessionPlanFixture({
        runtime: { sessions: { open: openCodexNativeAppServerSession } },
        lease, backend: resolution.backend, agent: resolution.agent,
        createSessionHostServiceOwners,
        // The process/native IPC boundary is the canonical Codex socket fixture.
        createInvocationServices: async () => services,
        sessionInput: buildPluginSessionBindingInput({ credentials, directory,
          backendTarget: { kind: 'backend', backendId: 'codex' },
          environmentVariables: { CODEX_HOME: directory },
          agentSessionStartupInstructionsV1: { v: 1, id: 'resume-proof', revision: 1, instructions: 'Reply without using tools.' },
        }),
      });
      const plan = withHostSessionRuntimeIdentityPublication({ plan: nativePlan,
        identity: { runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null } });
      const created = await plan.config.createSessionRuntime?.({ directory, machineId: 'machine-1',
        metadata: session.getMetadataSnapshot(), session, transcriptSession: {}, messageBuffer: {}, mcpServers: {},
        permissionHandler: { cancelByPluginTurn: async () => undefined }, getPermissionMode: () => 'read-only',
        memoryRecallGuidanceEnabled: false,
      } as never);
      if (!created) throw new Error('Native host factory unavailable');
      try {
        const metadata = session.getMetadataSnapshot();
        expect(RuntimeDescriptorV1Schema.parse(metadata.runtimeDescriptorV1)).toMatchObject({
          v: 1, agentId: 'codex', agent: { backendMode: 'appServer' },
        });
        const owner = createSessionOwnerMetadataV1({ metadata });
        expect(owner.ok).toBe(true);
        if (!owner.ok) throw new Error('Native descriptor rejected by owner persistence schema');
        SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata);
        // Native identity and descriptor reach the real state engine; only its Home persistence port is substituted.
        const state = createCliRuntimeSessionStateBridge({ credentials, session,
          metadataPort: { update: async (_id, updater) => {
            await session.updateMetadata(current => updater(current));
            return { ok: true, version: 1 };
          } },
        });
        const unsubscribe = subscribeSessionRuntimePublicationToMetadata({ session: session as never,
          sessionState: state.engine, runtime: created.operations, providerSessionMetadataKey: 'codexSessionId' });
        const stopMessages = created.operations.subscribeRuntimeEvents(unsubscribe.observeRuntimeEvent);
        try {
          await created.operations.sendTurnPrompt('Initial message', { localId: 'initial-input', turnId: 'initial-turn' });
          await created.operations.waitForTurnCompletion();
          await vi.waitFor(() => expect(session.getMetadataSnapshot().codexSessionId).toBe('fresh-thread'));
        } finally { stopMessages(); unsubscribe(); }
        const persisted = session.getMetadataSnapshot();
        const rawSession = { ...createSessionNotificationContextFixture(sessionId), machineId: 'machine-1', path: directory,
          encryptionMode: 'plain' as const, metadata: JSON.stringify(persisted) };
        const options = buildInactiveSessionResumeSpawnOptions({ sessionId, rawSession, metadata: persisted });
        expect(options).toMatchObject({ existingSessionId: sessionId, runtimeDescriptorV1: metadata.runtimeDescriptorV1 });
        if (!options) throw new Error('Persisted native open is not resumable');
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happySessionId: sessionId, startedBy: 'daemon' };
        const resume = { sessionId, rawSession, metadata: persisted };
        const inventory = { coverage: 'complete' as const, items: (['session', 'input', 'agents', 'attention'] as const).map(category => ({
          category, ownerRef: tracked, attribution: { kind: 'unknown' as const }, state: 'settled' as const, settledAt: 20,
        })) };
        const eligibility = await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume });
        expect(eligibility).toMatchObject({ eligible: true, resumeOptions: options });
        const root = { owner: { kind: 'session' as const, sessionId }, pid: tracked.pid,
          start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 0 };
        expect(await sessionStop({ candidate: { kind: 'session', root, settledAt: 20,
          target: { kind: 'session', root, tracked, eligibility, label: 'Codex' } },
          signal: new AbortController().signal, readCurrentTracked: () => tracked,
          readCurrentEligibility: async () => await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume }),
          // Runner termination is an OS boundary; dispose the real native runtime.
          stopSession: async () => { await created.operations.resetOrDisposeRuntime(); return true; },
        })).toEqual({ status: 'stopped' });
        // Only Home HTTP is substituted. Identity, decryption, snapshot and native resume admission stay real.
        const http = vi.spyOn(axios, 'get').mockImplementation(async input => {
          const url = new URL(String(input));
          if (url.pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
          if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
          throw new Error(`Unexpected Home request: ${url.pathname}`);
        });
        try {
          const admitted = await runWithServerHttpBaseUrl('https://codex-resume.example', () => prepareExecuteSpawnSessionRequest({
            request: { options, credentials }, validateEnvVarRecordStrict,
          }));
          expect(admitted).toMatchObject({ effectiveResume: 'fresh-thread', runtimeDescriptorV1: metadata.runtimeDescriptorV1 });
          if ('type' in admitted) throw new Error('Inactive admission refused the automatically stopped Session');
          const resumed = await openCodexNativeAppServerSession({
            kind: 'resume', providerSessionId: admitted.effectiveResume, sessionId, cwd: directory,
            runtimeDescriptorV1: admitted.runtimeDescriptorV1,
            launchEnvironment: { values: { CODEX_HOME: directory }, unset: [] },
            configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
              permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} }, mcpServers: {},
          }, { signal: new AbortController().signal,
            services, session: { id: sessionId, services: {} },
            ui: { title: { set: async () => undefined } },
          } as never);
          try {
            const events: unknown[] = [];
            const subscription = resumed.watch(event => { events.push(event); });
            await resumed.send({ inputIds: ['wake-input'], input: { text: 'Next message' },
              delivery: { kind: 'newTurn', turnId: 'wake-turn' } });
            await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
              expect.objectContaining({ kind: 'message-delta', channel: 'assistant', text: 'answered-next-message' }),
            ])));
            await subscription.dispose();
          } finally { await resumed.dispose(); }
        } finally { http.mockRestore(); }
      } finally { await created.operations.resetOrDisposeRuntime(); }
    }, { onTurnStart: ({ socket, params, turnId }) => {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId,
        itemId: 'wake-answer', delta: 'answered-next-message' } }));
      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } }));
    } });
});

it('keeps a descriptor-less Codex Session that inactive admission cannot resume', async () => {
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happySessionId: 'session-1', startedBy: 'daemon' };
  const resume = { sessionId: 'session-1', rawSession: { machineId: 'machine-1', path: '/project' },
    metadata: { machineId: 'machine-1', path: '/project', flavor: 'codex', codexSessionId: 'native-1' } };
  const inventory = { coverage: 'complete' as const, items: (['session', 'input', 'agents', 'attention'] as const).map(category => ({
    category, ownerRef: tracked, attribution: { kind: 'unknown' as const }, state: 'settled' as const, settledAt: 20,
  })) };
  expect(await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume }))
    .toMatchObject({ eligible: false, reasons: [{ kind: 'not_resumable' }] });
});

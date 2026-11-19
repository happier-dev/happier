import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { getVendorResumeSupport } from './catalogHooks';
import { resolveCapabilityApplyAgentFacts } from './capabilityApplyFacts';
import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';
import { createNativeAgentHostSessionRuntimePlan } from '@/plugins/runtime/runtimeCore/plugin/session';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { readRegistryCatalogHook } from '@/agent/catalog/runtimeEntry';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { resolveCapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../../../packages/plugins/codex/src/protocol/runtimeDescriptorV1';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { createCapabilitySelectionSynchronizer } from '@/agent/runtime/capabilitySelectionSynchronizer';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { readSessionCapabilityAgentFactsV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { Metadata } from '@/api/types';
import type { RestartSessionRunnerRequestV1 } from '@happier-dev/protocol';

describe('session resume through the applied plugin runtime', () => {
  it('demands the Codex resume hook and fences it after its runtime retires', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-resume-catalog-'));
    let unownedRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
    let adopted = false;
    try {
      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
          kind: 'development',
          registeredRootId: `resume-catalog-integration:${pluginId}`,
          canonicalRoot: rootPath,
          observedRevision: 1,
        }),
      });
      expect(unownedRegistry.contributes.catalogEntriesById.codex?.getVendorResumeSupport)
        .toBeUndefined();
      const appServer = {
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({ backendMode: 'appServer' }),
      };
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'codex', metadata: appServer,
        sessionRunning: true, registry: unownedRegistry })).resolves.toMatchObject({ vendorResume: 'experimental' });
      // An incumbent Session holds its registry; another global catalog must
      // neither replace its declared support nor supply its lazy predicate.
      const capturedSupportsResume = await getVendorResumeSupport('codex', unownedRegistry);
      expect(capturedSupportsResume(appServer)).toBe(true);
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'codex', metadata: {},
        sessionRunning: true, registry: unownedRegistry })).resolves.toMatchObject({ vendorResume: 'unsupported' });
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'missing-agent', metadata: appServer,
        sessionRunning: true, registry: unownedRegistry })).resolves.toEqual({ vendorResume: 'unsupported', skillsLiveReload: 'unsupported' });
      // The Agent factory is the native system boundary. Its admitted descriptor
      // must survive host decoration before initial apply facts are computed.
      const operations: RuntimeTurnOperations & { setOnPromptDeliveryOutcome(): void } = {
        beginTurnLifecycle() {}, sendTurnPrompt: async () => {}, steerInFlightTurn: async () => {},
        waitForTurnCompletion: async () => {}, subscribeRuntimeEvents: () => () => {},
        cancelTurn: async () => {}, readSessionIdentity: () => ({ sessionId: 'vendor-thread' }),
        updateSessionRuntimeConfig: async () => {}, resetOrDisposeRuntime: async () => {},
        setOnPromptDeliveryOutcome() {},
      };
      const declaredAgent = unownedRegistry.contributes.agentDefinitionsById.get('codex')!;
      let admittedCatalogEntry = declaredAgent.catalogEntry;
      const agentContribution = { ...declaredAgent, get catalogEntry() { return admittedCatalogEntry; } };
      const plan = await createNativeAgentHostSessionRuntimePlan({
        agent: agentContribution,
        backend: projectEngineRuntimeContributionFromAgent(agentContribution, 'codex'),
        sessionInput: { credentials: { token: 'test-home', encryption: null },
          bootstrap: { workingDirectory: happyHomeDir }, resume: {}, runtimePreferences: {} },
        createSessionRuntime: async () => {
          admittedCatalogEntry = await readRegistryCatalogHook(unownedRegistry!, 'codex', entry => entry);
          return { operations, runtimeDescriptorV1: appServer.runtimeDescriptorV1 };
        },
      });
      const wrapped = withHostSessionRuntimeIdentityPublication({ plan, identity: {
        runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null,
      } });
      const opened = await wrapped.config.createSessionRuntime!({
        session: { updateMetadata: async () => {} },
      } as Parameters<NonNullable<typeof wrapped.config.createSessionRuntime>>[0]);
      const agent = await resolveCapabilityApplyAgentFacts({ agentId: 'codex', metadata: {
        runtimeDescriptorV1: opened.runtimeDescriptorV1,
      }, sessionRunning: true, catalogEntry: wrapped.config.readSessionAgent?.().catalogEntry ?? null });
      expect(resolveCapabilityApplyTimingV1({ kind: 'mcp_server', sessionRunning: true, agent, launchRestart: 'automatic' }))
        .toEqual({ t: 'next_turn' });
      let metadata = createTestMetadata({ flavor: 'codex', startedBy: 'daemon' });
      const session = { sessionId: 'session', updateMetadata: async (update: (value: Metadata) => Metadata) => {
        metadata = update(metadata);
      } };
      const sessionState = createCliRuntimeSessionStateBridge({ session,
        credentials: { token: 'test-home', encryption: null },
        metadataPort: { update: async (_sessionId, update) => {
          metadata = createTestMetadata(update(metadata));
          return { ok: true, version: 1 };
        } },
      }).engine;
      const unsubscribe = subscribeSessionRuntimePublicationToMetadata({ session, sessionState,
        runtime: opened.operations, providerSessionMetadataKey: wrapped.config.providerSessionMetadataKey,
        capabilitySelection: agent });
      await setImmediate();
      const owner = createSessionOwnerMetadataV1({ metadata });
      if (!owner.ok) throw new Error(`Host publication rejected by the owner envelope: ${owner.unsupportedFields.join(', ')}`);
      SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata);
      expect(readSessionCapabilityAgentFactsV1(metadata)).toEqual({ vendorResume: 'experimental', skillsLiveReload: 'supported' });
      let settled = false;
      const restarts: RestartSessionRunnerRequestV1[] = [];
      const synchronizer = createCapabilitySelectionSynchronizer({
        session: { sessionId: session.sessionId, getMetadataSnapshot: () => metadata,
          updateMetadataAsCurrentPublisher: session.updateMetadata },
        agent, isStarted: () => true, isSettled: () => settled,
        requestRestart: async request => {
          restarts.push(request);
          return { ok: true, status: 'restarted', sessionId: session.sessionId };
        },
      });
      try {
        metadata = writeSessionCapabilitySelectionToMetadataV1(metadata, {
          mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['new-server'], forceExcludeServerIds: [] },
        }, { sessionActive: true });
        synchronizer.syncFromMetadata();
        await synchronizer.flushBeforeTurn();
        expect(restarts).toEqual([]);
        settled = true;
        await synchronizer.flushAfterSettledTurn('completed-turn');
        expect(restarts).toEqual([{ sessionId: session.sessionId, mode: 'force_current_cli', reason: 'capability_selection_change' }]);
      } finally { await synchronizer.dispose(); unsubscribe(); }
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: ['happier.agent.codex'],
        durableRevision: 1,
        runningSessionDisposition: 'retainRunningSessions',
      });
      adopted = true;
      unownedRegistry = null;

      // The daemon's ordinary resume check must demand its Agent-owned hook;
      // no earlier preflight or external-session request is required to warm it.
      const supportsResume = await getVendorResumeSupport('codex');
      expect(supportsResume(appServer)).toBe(true);
      expect(supportsResume({})).toBe(false);
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'codex', metadata: appServer,
        sessionRunning: true, catalogEntry: null })).resolves.toEqual({ vendorResume: 'unsupported', skillsLiveReload: 'unsupported' });

      await pluginReloadController.shutdown({ timeoutMs: 5_000 });
      adopted = false;
      expect(supportsResume(appServer)).toBe(false);
      expect(capturedSupportsResume(appServer)).toBe(false);
    } finally {
      if (adopted) await pluginReloadController.shutdown({ timeoutMs: 5_000 });
      await unownedRegistry?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});

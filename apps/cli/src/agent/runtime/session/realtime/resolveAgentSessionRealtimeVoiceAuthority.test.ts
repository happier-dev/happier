import type {
  PluginContributionIdentityV1,
  VoiceProviderContribution,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  resolveAgentSessionRealtimeVoiceAuthority,
  resolveRetainedAgentSessionRealtimeVoiceAuthority,
} from './resolveAgentSessionRealtimeVoiceAuthority';

const selectedAgent = {
  pluginId: 'acme.voice-agent',
  localId: 'codex',
} as const;
const installedProvider = {
  pluginId: 'example.voice.never-seen',
  localId: 'conversation',
} as const;
const wrongAgentProvider = {
  pluginId: installedProvider.pluginId,
  localId: 'wrong-agent',
} as const;
const fixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
});

async function providerRegistry(definitions: readonly VoiceProviderContribution[]) {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{
      manifest: createPluginManifestV2Fixture({
        id: selectedAgent.pluginId,
        entrypoints: {},
        contributes: { systemTools: [{ id: 'fixture-acp', title: 'Fixture ACP', executableNames: ['fixture-acp'] }], agents: [selectedAgent.localId, 'other'].map((id) => ({
          id, title: id, primary: 'sessions',
          runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } } },
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        })) },
      }),
      files: {},
    }, {
      manifest: createPluginManifestV2Fixture({
        id: installedProvider.pluginId,
        activation: { events: [{ kind: 'startup' }] },
        contributes: { voiceProviders: definitions },
      }),
      files: { 'daemon.mjs': 'export function activate(api) {}' },
    }],
  });
  fixtures.push(fixture);
  return fixture;
}

function registryAgent(fixture: Awaited<ReturnType<typeof providerRegistry>>, localId: string = selectedAgent.localId) {
  const agent = [...fixture.registry.agentRuntimesByAgentId.values()].find((entry) => entry.pluginId === selectedAgent.pluginId && entry.localAgentId === localId);
  if (!agent) throw new Error('Admitted Agent runtime missing');
  return agent;
}
function conversation(
  id: string,
  agent: PluginContributionIdentityV1,
  bindingAgent: PluginContributionIdentityV1 | null = agent,
): Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
> {
  return {
    id,
    title: id,
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: {
      turn: { cancelResponse: false, bargeIn: false },

    },
    execution: {
      kind: 'experimental_agent_session_realtime',
      agent,
      supportedRuntimeVersions: ['1.2.3'],
    },
    ...(bindingAgent
      ? {
          settings: {
            schemaVersion: 2,
            fields: [],
            connectedServicesBinding: {
              id: 'globalConnectedServices',
              title: 'Agent account',
              agent: bindingAgent,
              serviceIds: ['openai-codex'],
            },
          },
        }
      : {}),
    client: {
      artifactId: 'installed-voice-runtime',
      exportName: 'activate',
    },
  };
}

describe('resolveAgentSessionRealtimeVoiceAuthority', () => {
  it('materializes exact installed declarations from the current registry occurrence', async () => {
    const fixture = await providerRegistry([
      conversation(installedProvider.localId, selectedAgent),
      conversation(wrongAgentProvider.localId, { pluginId: selectedAgent.pluginId, localId: 'other' }),
    ]);
    const providerOccurrence = fixture.registry.readPluginOccurrenceId?.(installedProvider.pluginId);
    expect(providerOccurrence).toBeTruthy();
    const agent = registryAgent(fixture);
    const authority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: fixture.registry,
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: agent,
      agentRetirementSignal: agent.retirementSignal,
    });

    expect(authority).not.toBeNull();
    expect(authority?.occurrenceId).toBe(agent.occurrenceId);
    expect(authority?.resolveDeclaration(installedProvider)?.id).toBe(
      installedProvider.localId,
    );
    expect(authority?.resolveProviderOccurrenceId(installedProvider)).toBe(
      providerOccurrence,
    );
    expect(authority?.isCurrent(installedProvider)).toBe(true);
    expect(authority?.resolveDeclaration(wrongAgentProvider)).toBeNull();
    expect(authority?.isCurrent(wrongAgentProvider)).toBe(false);

    await fixture.dispose();
    expect(authority?.isCurrent(installedProvider)).toBe(false);
    expect(
      authority?.resolveRetirementSignal(installedProvider)?.aborted,
    ).toBe(true);
  });

  it('fails closed when the selected runtime identity is not the policy Agent', async () => {
    const fixture = await providerRegistry([conversation(installedProvider.localId, selectedAgent)]);
    expect(resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: fixture.registry,
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: registryAgent(fixture, 'other'),
    })).toBeNull();
  });

  it('keeps an Agent-session realtime declaration eligible without a Connected Services binding', async () => {
    const fixture = await providerRegistry([conversation(installedProvider.localId, selectedAgent, null)]);
    const authority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: fixture.registry,
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: registryAgent(fixture),
    });

    expect(authority?.resolveDeclaration(installedProvider)?.id).toBe(
      installedProvider.localId,
    );
    expect(authority?.isCurrent(installedProvider)).toBe(true);
  });

  it('fails closed for a malformed runner-carried retained Agent binding', async () => {
    const fixture = await providerRegistry([conversation(installedProvider.localId, selectedAgent)]);
    expect(resolveRetainedAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: fixture.registry,
      retainedAgent: {
        pluginId: selectedAgent.pluginId,
        agentId: 'codex-session',
        localAgentId: selectedAgent.localId,
        immutableGenerationId: 'installed-agent-generation-G',
      },
    })).toBeNull();
  });

  it('keeps retained G Voice authority current when H replaces its registry Agent, then retires with the current Voice provider', async () => {
    const fixture = await providerRegistry([conversation(installedProvider.localId, selectedAgent)]);
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId: selectedAgent.pluginId,
      pluginVersion: '1.2.3',
      agentId: 'codex-session',
      localAgentId: selectedAgent.localId,
      sourceCustody: {
        kind: 'managed',
        immutableGenerationId: 'installed-agent-generation-G',
        installSource: 'npm',
      },
      locator: {
        module: './agent/runtime.js',
        export: 'createAgentRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: 'agent/runtime.js',
      loadMode: 'immutable-js',
    });
    // The retained G runner has independent source custody from the registry's
    // newly admitted H Agent; the real registry remains the provider authority.
    const currentAgent = registryAgent(fixture);
    expect(currentAgent.sourceCustody).not.toEqual(retainedAgent.sourceCustody);
    const authority = resolveRetainedAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: fixture.registry,
      retainedAgent,
    });

    const retirementSignal = authority?.resolveRetirementSignal(installedProvider);
    expect(authority?.occurrenceId).toBe(
      JSON.stringify(retainedAgent.sourceCustody),
    );
    expect(authority?.isCurrent(installedProvider)).toBe(true);
    expect(retirementSignal?.aborted).toBe(false);

    await fixture.dispose();

    expect(retirementSignal?.aborted).toBe(true);
    expect(authority?.isCurrent(installedProvider)).toBe(false);
  });
});

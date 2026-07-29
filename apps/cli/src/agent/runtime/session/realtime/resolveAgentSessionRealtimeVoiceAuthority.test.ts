import type {
  PluginContributionIdentityV1,
  PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveAgentSessionRealtimeVoiceAuthority } from './resolveAgentSessionRealtimeVoiceAuthority';

const selectedAgent = {
  pluginId: 'happier.agent.codex',
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

function conversation(
  id: string,
  agent: PluginContributionIdentityV1,
): Extract<
  PluginVoiceProviderContributionV1,
  Readonly<{ kind: 'conversation' }>
> {
  return {
    id,
    title: id,
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: {
      readiness: { requirements: [] },
      turn: { cancelResponse: false, bargeIn: false },
    },
    execution: {
      kind: 'experimental_agent_session_realtime',
      agent,
    },
    client: {
      artifactId: 'installed-voice-runtime',
      modulePath: './voice',
      exportName: 'activate',
    },
  };
}

describe('resolveAgentSessionRealtimeVoiceAuthority', () => {
  it('materializes exact installed declarations from the current registry generation', () => {
    let current = true;
    const retirement = new AbortController();
    const authority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: {
        contributes: {
          voiceProviders: [
            {
              pluginId: installedProvider.pluginId,
              identity: installedProvider,
              manifestDigest: 'manifest:installed',
              definition: conversation(
                installedProvider.localId,
                selectedAgent,
              ),
            },
            {
              pluginId: wrongAgentProvider.pluginId,
              identity: wrongAgentProvider,
              manifestDigest: 'manifest:installed',
              definition: conversation(
                wrongAgentProvider.localId,
                {
                  pluginId: 'happier.agent.other',
                  localId: 'other',
                },
              ),
            },
          ],
        },
        resolveContributionRuntimeLifecycle: () => ({
          generation: 'installed-provider-generation',
          isCurrent: () => current,
          retirementSignal: retirement.signal,
        }),
      },
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: {
        pluginId: selectedAgent.pluginId,
        agentId: selectedAgent.localId,
        generation: 'agent-generation',
        immutableGenerationId: 'installed-agent-generation',
        isCurrent: () => current,
      },
      agentRetirementSignal: retirement.signal,
    });

    expect(authority).not.toBeNull();
    expect(authority?.generation).toBe('installed-agent-generation');
    expect(authority?.resolveDeclaration(installedProvider)?.id).toBe(
      installedProvider.localId,
    );
    expect(authority?.resolveProviderGeneration(installedProvider)).toBe(
      'installed-provider-generation',
    );
    expect(authority?.isCurrent(installedProvider)).toBe(true);
    expect(authority?.resolveDeclaration(wrongAgentProvider)).toBeNull();
    expect(authority?.isCurrent(wrongAgentProvider)).toBe(false);

    current = false;
    retirement.abort();
    expect(authority?.isCurrent(installedProvider)).toBe(false);
    expect(
      authority?.resolveRetirementSignal(installedProvider)?.aborted,
    ).toBe(true);
  });

  it('fails closed when the selected runtime identity is not the policy Agent', () => {
    expect(resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: {
        contributes: { voiceProviders: [] },
        resolveContributionRuntimeLifecycle: () => null,
      },
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: {
        pluginId: selectedAgent.pluginId,
        agentId: 'other',
        generation: 'agent-generation',
        isCurrent: () => true,
      },
    })).toBeNull();
  });
});

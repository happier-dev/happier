import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const featureState = vi.hoisted(() => ({
  accountGroups: false,
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
vi.mock('@/components/ui/lists/Item', () => ({
  // Test-renderer host preserves the Item contract without pulling in native styling.
  Item: (props: any) => React.createElement('Item', props),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => featureState.accountGroups,
}));
vi.mock('@/sync/store/hooks', () => ({
  useProfile: () => ({ connectedServicesV2: [] }),
  useSettings: () => ({
    connectedServicesProfileLabelByKey: {},
    connectedServicesDefaultProfileByServiceId: {},
  }),
}));
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

describe('VoiceGlobalConnectedServicesBindingField', () => {
  it('keeps the declared core binding interactive when optional account groups are disabled', async () => {
    const { VoiceGlobalConnectedServicesBindingField } = await import(
      './VoiceGlobalConnectedServicesBindingField'
    );
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField
      agentId="codex"
      serviceIds={['openai-codex']}
      title="Codex account"
      subtitle="Account used for global Codex Voice"
      value={null}
      onChange={vi.fn()}
    />);

    const item = screen.tree.findByType('Item' as any);
    expect(item.props).toMatchObject({
      testID: 'voice-realtime-connected-services-codex',
      title: 'Codex account',
      subtitle: 'Account used for global Codex Voice',
      detail: 'common.none',
      showChevron: true,
    });
    expect(item.props.onPress).toEqual(expect.any(Function));
  });

  it('uses a schema-valid installed qualified Agent without falling back through its colliding bundled local id', async () => {
    const { VoiceGlobalConnectedServicesBindingField } = await import(
      './VoiceGlobalConnectedServicesBindingField'
    );
    const pluginId = 'acme.installed-agent';
    const contributions = PluginContributesV2Schema.parse({
      agents: [{
        id: 'claude',
        title: 'Installed Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        connectedAccounts: [{
          purpose: 'primary',
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          required: false,
        }],
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      }],
      voiceProviders: [{
        id: 'conversation',
        title: 'Installed Agent Voice',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
          readiness: { requirements: [] },
          turn: { cancelResponse: false, bargeIn: false },
        },
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: 'claude',
        },
        settings: {
          schemaVersion: 2,
          fields: [],
          connectedServicesBinding: {
            id: 'globalConnectedServices',
            title: 'Installed Agent account',
            agent: 'claude',
            serviceIds: ['openai-codex'],
          },
        },
        client: {
          artifactId: 'voice-runtime-web',
          modulePath: './voiceRuntime',
          exportName: 'activate',
        },
      }],
    });
    const installedAgent = contributions.agents[0]!;
    const installedVoiceProvider = contributions.voiceProviders[0]!;
    if (
      installedVoiceProvider.kind !== 'conversation'
      || !installedVoiceProvider.settings?.connectedServicesBinding
    ) {
      throw new Error('expected installed Agent-session Voice declaration');
    }
    const installedBinding = installedVoiceProvider.settings.connectedServicesBinding;
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField
      agentId={{ pluginId, localId: installedAgent.id }}
      serviceIds={installedBinding.serviceIds}
      title="Installed Agent account"
      value={null}
      onChange={vi.fn()}
    />);

    expect(screen.tree.findByType('Item' as any).props).toMatchObject({
      title: 'Installed Agent account',
      detail: 'common.none',
      showChevron: true,
      onPress: expect.any(Function),
    });
  });
});

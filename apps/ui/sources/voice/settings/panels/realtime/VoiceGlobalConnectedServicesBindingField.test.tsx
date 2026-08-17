import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const featureState = vi.hoisted(() => ({
  accountGroups: false,
}));
const profileState = vi.hoisted(() => ({
  connectedServicesV2: [] as Array<{
    serviceId: string;
    profiles: Array<{
      profileId: string;
      status: 'connected';
      kind: 'oauth' | 'token';
      providerEmail: string;
    }>;
  }>,
}));
const modalShow = vi.hoisted(() => vi.fn());

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
  useProfile: () => profileState,
  useSettings: () => ({
    connectedServicesProfileLabelByKey: {},
    connectedServicesDefaultProfileByServiceId: {},
  }),
}));
vi.mock('@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent', () => ({
  NewSessionConnectedServicesSelectionContent: (props: Record<string, unknown>) =>
    React.createElement('ConnectedServicesPicker', props),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { show: modalShow } }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

describe('VoiceGlobalConnectedServicesBindingField', () => {
  beforeEach(() => {
    featureState.accountGroups = false;
    profileState.connectedServicesV2 = [];
    modalShow.mockClear();
  });

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

    act(() => item.props.onPress());
    const modalConfig = modalShow.mock.calls[0]?.[0] as {
      component: React.ComponentType<Record<string, unknown>>;
      props: Record<string, unknown>;
    } | undefined;
    expect(modalConfig).toBeDefined();
    if (!modalConfig) throw new Error('expected Connected Services picker modal');
    const pickerScreen = await renderScreen(React.createElement(
      modalConfig.component,
      { ...modalConfig.props, onClose: vi.fn() },
    ));
    expect(pickerScreen.tree.findByType('ConnectedServicesPicker' as any).props).toMatchObject({
      bindingsByServiceId: {},
      allowDefaultProfileFallback: false,
      includeNativeAuthOption: false,
    });
  });

  it.each([
    {
      caseName: 'the bundled Agent metadata omits the declared service',
      serviceId: 'anthropic',
      profileId: 'anthropic-work',
      kind: 'token' as const,
    },
    {
      caseName: 'the bundled Agent metadata marks the healthy profile kind unsupported',
      serviceId: 'openai-codex',
      profileId: 'codex-token',
      kind: 'token' as const,
    },
  ])('shows and selects the healthy Voice-declared profile when $caseName', async ({
    serviceId,
    profileId,
    kind,
  }) => {
    profileState.connectedServicesV2 = [{
      serviceId,
      profiles: [{
        profileId,
        status: 'connected',
        kind,
        providerEmail: `${profileId}@example.com`,
      }],
    }];
    const onChange = vi.fn();
    const { VoiceGlobalConnectedServicesBindingField } = await import(
      './VoiceGlobalConnectedServicesBindingField'
    );
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField
      agentId="codex"
      serviceIds={[serviceId]}
      title="Voice account"
      value={null}
      onChange={onChange}
    />);

    const item = screen.tree.findByType('Item' as any);
    expect(item.props.onPress).toEqual(expect.any(Function));
    act(() => item.props.onPress());

    const modalConfig = modalShow.mock.calls[0]?.[0] as {
      component: React.ComponentType<Record<string, unknown>>;
      props: Record<string, unknown>;
    } | undefined;
    expect(modalConfig).toBeDefined();
    if (!modalConfig) throw new Error('expected Connected Services picker modal');
    const pickerScreen = await renderScreen(React.createElement(
      modalConfig.component,
      { ...modalConfig.props, onClose: vi.fn() },
    ));
    const picker = pickerScreen.tree.findByType('ConnectedServicesPicker' as any);

    expect(picker.props.supportedServiceIds).toEqual([serviceId]);
    expect(picker.props.profileOptionsByServiceId[serviceId]).toEqual([
      expect.objectContaining({
        profileId,
        status: 'connected',
        kind,
      }),
    ]);

    act(() => picker.props.setBindingForService(serviceId, {
      source: 'connected',
      selection: 'profile',
      profileId,
    }));
    expect(onChange).toHaveBeenCalledWith({
      v: 1,
      bindingsByServiceId: {
        [serviceId]: {
          source: 'connected',
          selection: 'profile',
          profileId,
        },
      },
    });
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
          turn: { cancelResponse: false, bargeIn: false },
        },
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: 'claude',
          supportedRuntimeVersions: ['1.2.3'],
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

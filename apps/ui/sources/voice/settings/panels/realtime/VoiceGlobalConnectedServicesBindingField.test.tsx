import { waitForTestEvent } from '@/dev/testkit';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceBindingsV2Schema,
  PluginContributesV2Schema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
} from '@happier-dev/protocol';

import { renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { Item } from '@/components/ui/lists/Item';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';
import { ModalProvider } from '@/modal/ModalProvider';
import { t, setPreferredLanguageFromSettings } from '@/text';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createConnectedServiceOptionId } from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';

let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;

function renderScreen(element: React.ReactElement) {
  return renderTestScreen(<InjectedAuthProvider credentials={account.credentials}>
    <ModalProvider>{element}</ModalProvider>
  </InjectedAuthProvider>);
}

const profileState = {
  get connectedServicesV2() { return storage.getState().profile.connectedServicesV2; },
  set connectedServicesV2(value: unknown) {
    storage.setState(state => ({ profile: AccountProfileSchema.parse({ ...state.profile, connectedServicesV2: value }) }));
  },
};
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.native ?? values.default },
  useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('VoiceGlobalConnectedServicesBindingField', () => {
  beforeEach(async () => {
    account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
    onTestFinished(account.dispose);
    setPreferredLanguageFromSettings('en');
    profileState.connectedServicesV2 = [];
  });
  afterEach(standardCleanup);

  it('writes qualified Local Voice account and pool selections with the Session V2 contract', async () => {
    const { VoiceGlobalConnectedServicesBindingField } = await import('./VoiceGlobalConnectedServicesBindingField');
    const onChange = vi.fn();
    const serviceId = 'happier.agent.codex/openai-codex';
    const screen = await renderScreen(<VoiceGlobalConnectedServicesBindingField agentId="codex"
      serviceIds={[serviceId]} bindingVersion={2} value={null} onChange={onChange} />);
    await act(async () => screen.tree.findByType(Item).props.onPress());
    const selection = screen.tree.findByType(NewSessionConnectedServicesSelectionContent);
    expect(selection.props.supportedServiceIds).toEqual([serviceId]);
    await act(async () => selection.props.setBindingForService(serviceId, {
      source: 'connected', selection: 'group', groupId: 'voice-pool',
    }));
    expect(onChange).toHaveBeenLastCalledWith({ v: 2, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'group', groupId: 'voice-pool' },
    } }, expect.any(Number));
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

    const item = screen.tree.findByType(Item);
    expect(item.props).toMatchObject({
      testID: 'voice-realtime-connected-services-codex',
      title: 'Codex account',
      subtitle: 'Account used for global Codex Voice',
      detail: t('common.none'),
      showChevron: true,
    });
    expect(item.props.onPress).toEqual(expect.any(Function));

    await act(async () => item.props.onPress());
    expect(screen.tree.findByType(NewSessionConnectedServicesSelectionContent).props).toMatchObject({
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
    // React replays updaters in StrictMode; the actual modal host and picker
    // remain inside that lifecycle, and one physical selection must emit once.
    const screen = await renderScreen(<React.StrictMode><VoiceGlobalConnectedServicesBindingField
      agentId="codex"
      serviceIds={[serviceId]}
      title="Voice account"
      value={null}
      onChange={onChange}
    /></React.StrictMode>);

    const item = screen.tree.findByType(Item);
    expect(item.props.onPress).toEqual(expect.any(Function));
    await act(async () => item.props.onPress());
    const picker = screen.tree.findByType(NewSessionConnectedServicesSelectionContent);
    const pickerSettingsVersion = storage.getState().settingsVersion;
    if (pickerSettingsVersion === null) throw new Error('Expected loaded settings version');
    // A server update while this picker is open cannot turn its stale selection into a fresh CAS.
    await act(async () => account.replaceSettings(account.settings, { version: pickerSettingsVersion + 1 }));

    expect(picker.props.supportedServiceIds).toEqual([serviceId]);
    expect(picker.props.profileOptionsByServiceId[serviceId]).toEqual([
      expect.objectContaining({
        profileId,
        status: 'connected',
        kind,
      }),
    ]);

    const optionId = createConnectedServiceOptionId(serviceId, profileId);
    const options = () => screen.tree.findAll(node => typeof node.type === 'string'
      && typeof node.props.onPress === 'function'
      && node.props.testID?.endsWith(`:option:${optionId}`));
    await waitForTestEvent(screen.subscribe, () => expect(options(), JSON.stringify(screen.tree.findAll(node => typeof node.type === 'string'
      && node.props.testID).map(node => node.props.testID))).toHaveLength(1));
    await act(async () => options()[0]!.props.onPress());
    const qualifiedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
    expect(qualifiedServiceId).not.toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[1]).toBe(pickerSettingsVersion);
    const emittedBinding = onChange.mock.calls[0]?.[0];
    expect(emittedBinding).toEqual({
      v: 1,
      bindingsByServiceId: {
        [qualifiedServiceId!]: {
          source: 'connected',
          selection: 'profile',
          profileId,
        },
      },
    });
    expect(ConnectedServiceBindingsV1Schema.safeParse(emittedBinding).success).toBe(true);
    expect(ConnectedServiceBindingsV2Schema.safeParse(emittedBinding).success).toBe(false);
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

    expect(screen.tree.findByType(Item).props).toMatchObject({
      title: 'Installed Agent account',
      detail: t('common.none'),
      showChevron: true,
      onPress: expect.any(Function),
    });
  });
});

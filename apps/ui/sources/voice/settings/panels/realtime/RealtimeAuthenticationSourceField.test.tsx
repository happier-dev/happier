import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const modalShow = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));
vi.mock('@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent', () => ({
  NewSessionConnectedServicesSelectionContent: (props: any) => React.createElement('ConnectedServicesPicker', props),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/sync/store/hooks', () => ({
  useProfile: () => ({
    connectedServicesV2: [{
      serviceId: 'openai',
      profiles: [{ profileId: 'work', status: 'connected', kind: 'token' }],
      groups: [],
    }],
  }),
  useSettings: () => ({
    connectedServicesProfileLabelByKey: {},
    connectedServicesDefaultProfileByServiceId: {},
  }),
}));
vi.mock('@/modal', () => ({ Modal: { show: modalShow } }));
vi.mock('@/text', () => ({ tLoose: (key: string) => key }));

const field = {
  kind: 'authentication_source',
  path: 'authentication',
  pathSegments: ['authentication'],
  titleKey: 'auth.title',
  subtitleKey: 'auth.subtitle',
  options: [
    { id: 'voice_saved_secret', titleKey: 'auth.saved' },
    {
      id: 'connected_service_api_key',
      purpose: 'realtime-openai-account',
      titleKey: 'auth.openai',
    },
    {
      id: 'connected_service_oauth',
      purpose: 'realtime-openai-codex-account',
      titleKey: 'auth.codex',
    },
  ],
} as const;

describe('RealtimeAuthenticationSourceField', () => {
  it('persists only the canonical purpose source without opening the legacy V2 picker', async () => {
    modalShow.mockClear();
    const onChange = vi.fn();
    const { RealtimeAuthenticationSourceField } = await import('./RealtimeAuthenticationSourceField');
    const screen = await renderScreen(<RealtimeAuthenticationSourceField
      field={field}
      value={{ source: 'voice_saved_secret' }}
      open
      onOpenChange={vi.fn()}
      onChange={onChange}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);

    act(() => dropdown.props.onSelect('connected_service_api_key'));
    expect(onChange).toHaveBeenCalledWith({
      source: 'connected_service_api_key',
    });
    expect(modalShow).not.toHaveBeenCalled();
  });

  it('switches explicitly to SavedSecret without retaining a Connected Service fallback', async () => {
    const onChange = vi.fn();
    const { RealtimeAuthenticationSourceField } = await import('./RealtimeAuthenticationSourceField');
    const screen = await renderScreen(<RealtimeAuthenticationSourceField
      field={field}
      value={{
        source: 'connected_service_api_key',
      }}
      open
      onOpenChange={vi.fn()}
      onChange={onChange}
    />);

    act(() => screen.tree.findByType('DropdownMenu' as any).props.onSelect('voice_saved_secret'));
    expect(onChange).toHaveBeenCalledWith({ source: 'voice_saved_secret' });
  });

  it('keeps all three authentication choices present and lets Codex OAuth be selected', async () => {
    const onChange = vi.fn();
    const { RealtimeAuthenticationSourceField } = await import('./RealtimeAuthenticationSourceField');
    const screen = await renderScreen(<RealtimeAuthenticationSourceField
      field={field}
      value={{ source: 'connected_service_api_key' }}
      open
      onOpenChange={vi.fn()}
      onChange={onChange}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);

    expect(dropdown.props.items.map((item: { id: string }) => item.id)).toEqual([
      'voice_saved_secret',
      'connected_service_api_key',
      'connected_service_oauth',
    ]);
    act(() => dropdown.props.onSelect('connected_service_oauth'));
    expect(onChange).toHaveBeenCalledWith({ source: 'connected_service_oauth' });
  });
});

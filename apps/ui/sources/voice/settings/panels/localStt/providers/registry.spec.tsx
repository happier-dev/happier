import React from 'react';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => {
  const theme = { colors: { textSecondary: '#999' } };
  return {
    useUnistyles: () => ({ theme }),
    StyleSheet: {
      create: (factory: any) => (typeof factory === 'function' ? {} : factory),
      absoluteFillObject: {},
    },
  };
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(),
    alert: vi.fn(),
  },
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children ?? null),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function'
        ? props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {} })
        : props.trigger ?? null,
    ),
}));

import { VoiceLocalSttProviderSchema } from '@/sync/domains/settings/voiceLocalSttSettings';

import { localSttProviderSpecs } from './registry';

describe('local STT provider registry', () => {
  it('covers every provider id in the settings schema', () => {
    const schemaIds = new Set<string>(VoiceLocalSttProviderSchema.options);
    const registryIds = new Set<string>(localSttProviderSpecs.map((spec) => spec.id));
    expect(registryIds).toEqual(schemaIds);
  });
});

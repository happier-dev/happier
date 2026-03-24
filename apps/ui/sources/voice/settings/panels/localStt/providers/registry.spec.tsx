import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installLocalSttProviderCommonModuleMocks } from './localSttProviderTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installLocalSttProviderCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
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

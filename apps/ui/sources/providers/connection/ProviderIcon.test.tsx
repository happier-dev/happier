import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('@expo/vector-icons', () => ({ Ionicons: { glyphMap: { 'sparkles-outline': 1 } } }));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: (props: Record<string, unknown>) => React.createElement('SafeIonicons', props),
}));

import { ProviderIcon } from './ProviderIcon';

describe('ProviderIcon', () => {
    it('uses a contributed installed icon token and fails safely to the generic provider icon', async () => {
        const contributed = await renderScreen(<ProviderIcon icon="sparkles-outline" size={29} color="black" />);
        expect(contributed.findByType('SafeIonicons').props.name).toBe('sparkles-outline');
        const fallback = await renderScreen(<ProviderIcon icon="https://remote.example/icon.svg" size={29} color="black" />);
        expect(fallback.findByType('SafeIonicons').props.name).toBe('cube-outline');
    });
});

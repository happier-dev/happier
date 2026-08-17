import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

import { ProviderIcon } from './ProviderIcon';

describe('ProviderIcon', () => {
    it('uses a contributed installed icon token and fails safely to the generic provider icon', async () => {
        const contributed = await renderScreen(<ProviderIcon icon="sparkle" size={29} color="black" />);
        expect(contributed.findByType('Icon').props.name).toBe('sparkle');
        const fallback = await renderScreen(<ProviderIcon icon="https://remote.example/icon.svg" size={29} color="black" />);
        expect(fallback.findByType('Icon').props.name).toBe('cube');
    });
});

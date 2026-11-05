import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('InlineCode', () => {
    it('keeps the shared chip identifier on its rendered core text host', async () => {
        const { InlineCode } = await import('./InlineCode');
        const screen = await renderScreen(<InlineCode testID="service-port">443</InlineCode>);

        expect(screen.findHostByTestId('service-port')).not.toBeNull();
        expect(screen.getTextContent()).toBe('443');
    });
});

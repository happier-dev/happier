import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import PluginUiSharedPresentationScreen from './plugin-ui';

describe('PluginUiSharedPresentationScreen', () => {
    it('renders direct core foundation presentation without a render recovery', async () => {
        const screen = await renderScreen(<PluginUiSharedPresentationScreen />);

        expect(screen.findByTestId('dev-plugin-ui-shared-presentation')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Ready');
        expect(screen.getTextContent()).toContain('Portable');
        expect(screen.getTextContent()).toContain('Summary content');
        // This test has no active Account scope or credentials. The demo can
        // still show core presentation, but it must not mount an executable
        // plugin artifact with a fabricated public SurfaceContext.
        expect(screen.findByTestId('plugin-action-execute')).toBeNull();
    });
});

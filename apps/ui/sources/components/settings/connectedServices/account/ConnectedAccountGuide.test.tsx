import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';

import { ConnectedAccountGuide } from './ConnectedAccountGuide';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('ConnectedAccountGuide', () => {
    it('offers a value the steps ask for with its own copy button', async () => {
        const screen = await renderScreen(<ConnectedAccountGuide guide={{ consoleUrl: 'https://provider.example/clients',
            steps: ['Register a client', 'Add the redirect URL below.'],
            copyValue: { label: 'Redirect URL', value: 'https://app.example/callback' } }} />);
        expect(screen.tree.findAllByType(CopyIconButton).map((node) => node.props.text)).toEqual(['https://app.example/callback']);
    });
});

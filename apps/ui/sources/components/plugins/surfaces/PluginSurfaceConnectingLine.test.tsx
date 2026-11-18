import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { PluginSurfaceConnectingLine } from './PluginSurfaceConnectingLine';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => { standardCleanup(); });

const position = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
    (StyleSheet.flatten(screen.findByTestId('plugin-surface-connecting-line')!.props.style) as { position?: string }).position;

describe('PluginSurfaceConnectingLine', () => {
    it('takes room in a widget body, so a card that hugs its content grows to hold it; on a page it floats over the surface', async () => {
        const widget = await renderScreen(
            <WidgetPresentationProvider value={{ size: 'medium', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}>
                <PluginSurfaceConnectingLine />
            </WidgetPresentationProvider>,
        );
        expect(position(widget)).not.toBe('absolute');
        standardCleanup();
        const page = await renderScreen(<PluginSurfaceConnectingLine />);
        expect(position(page)).toBe('absolute');
    });
});

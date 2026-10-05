import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DetailsTabHeader } from './DetailsTabHeader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function textOf(node: unknown): string {
    const parts: string[] = [];
    const walk = (value: unknown): void => {
        if (value == null || typeof value === 'boolean') return;
        if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
        if (Array.isArray(value)) { value.forEach(walk); return; }
        const children = (value as { children?: unknown }).children;
        if (Array.isArray(children)) { children.forEach(walk); return; }
        walk((value as { props?: { children?: unknown } }).props?.children);
    };
    walk(node);
    return parts.join(' ');
}

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('DetailsTabHeader', () => {
    it('keeps a long phone title readable and its identity switcher operable', async () => {
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
        const onSwitch = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader title="Key the settings modal by route, not window width" titleControl={<ToolbarButton testID="switch-stash" label="Kept on v0.3" onPress={onSwitch} />} />
            </SurfaceStateSizeProvider>,
        );
        await screen.pressByTestIdAsync('switch-stash');
        expect(onSwitch).toHaveBeenCalledOnce();
        await screen.unmount();
        const title = await renderScreen(<SurfaceStateSizeProvider size="phone"><DetailsTabHeader title="Key the settings modal by route, not window width" /></SurfaceStateSizeProvider>);
        expect(title.findByTestId('details-tab-header.title')?.props.numberOfLines).toBeUndefined();
    });
    it('keeps live status beside the facts in the shared band', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(<DetailsTabHeader title="Run" metaLeading={<Text testID="live-status">Waiting for you</Text>} meta={[{ key: 'agent', text: 'Codex' }]} />);
        expect(textOf(screen.findByTestId('live-status'))).toBe('Waiting for you');
        expect(screen.getTextContent()).toContain('Codex');
    });
    it('names the thing in the pane header band and reads its facts in order on the live line', async () => {
        const screen = await renderScreen(
            <DetailsTabHeader
                testID="hdr"
                title="SettingsModal.tsx"
                meta={[
                    { key: 'path', text: 'apps/ui/…/settings/', tone: 'muted', shrink: true },
                    { key: 'status', text: 'Modified' },
                    { key: 'stat', kind: 'diffStat', added: 4, removed: 2 },
                    { key: 'by', text: 'by Claude' },
                ]}
            />,
        );
        expect(textOf(screen.findByTestId('hdr.title'))).toBe('SettingsModal.tsx');
        expect(screen.findByTestId('hdr.title')?.props.accessibilityRole).toBe('header');
        const line = textOf(screen.findByTestId('hdr.subtitle'));
        expect(line.indexOf('Modified')).toBeLessThan(line.indexOf('+4'));
        expect(line).toContain('−2');
        expect(line.indexOf('−2')).toBeLessThan(line.indexOf('by Claude'));
    });

    it('runs the surface action it offers, and keeps it on a phone', async () => {
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const onRestore = vi.fn();
        for (const size of ['details', 'phone'] as const) {
            onRestore.mockClear();
            const screen = await renderScreen(
                <SurfaceStateSizeProvider size={size}>
                    <DetailsTabHeader
                        title="Kept on v0.3"
                        buttons={[{ label: 'Restore', tone: 'primary', onPress: onRestore, testID: 'restore' }]}
                    />
                </SurfaceStateSizeProvider>,
            );
            await screen.pressByTestIdAsync('restore');
            expect(onRestore).toHaveBeenCalledTimes(1);
            await screen.unmount();
        }
    });

    it('does not offer a busy action again', async () => {
        const onSave = vi.fn();
        const screen = await renderScreen(
            <DetailsTabHeader title="useSettingsRouteKey.ts" buttons={[{ label: 'Save', tone: 'primary', busy: true, onPress: onSave, testID: 'save' }]} />,
        );
        const save = screen.findByTestId('save');
        expect(save?.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
        expect(save?.props.onPress).toBeUndefined();
        expect(onSave).not.toHaveBeenCalled();
    });
});

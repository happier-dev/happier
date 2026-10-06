import * as React from 'react';
import { Pressable, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SidebarFooterPopoverButton } from './SidebarFooterPopoverButton';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The portal is a platform boundary; the control and its open/close owner remain real.
vi.mock('@/components/ui/popover', () => ({ Popover: (props: { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) =>
    <>{props.children({ maxHeight: 600, maxWidth: 400 })}</> }));

afterEach(standardCleanup);
it('opens the canonical footer popover from a full menu-row trigger', async () => {
    const screen = await renderScreen(<SidebarFooterPopoverButton testID="footer" iconName="desktop" label="Machines"
        renderTrigger={({ onPress, open }) => <Pressable testID="footer-menu-row" onPress={onPress} accessibilityState={{ expanded: open }} />}
        renderContent={() => <View testID="footer-real-content" />} />);
    expect(screen.findByTestId('footer-menu-row')).not.toBeNull();
    expect(screen.findByTestId('footer-real-content')).toBeNull();
    await screen.pressByTestIdAsync('footer-menu-row');
    expect(screen.findByTestId('footer-real-content')).not.toBeNull();
});

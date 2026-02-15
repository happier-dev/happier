import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useIsTablet: vi.fn(),
  useLocalSetting: vi.fn(),
  useWindowDimensions: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('@/utils/platform/responsive', () => ({
  useIsTablet: () => mocks.useIsTablet(),
}));

vi.mock('react-native', () => ({
  useWindowDimensions: () => mocks.useWindowDimensions(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useLocalSetting: (key: string) => mocks.useLocalSetting(key),
}));

vi.mock('./SidebarView', () => ({
  SidebarView: function SidebarView() {
    return React.createElement('SidebarView');
  },
}));

vi.mock('./CollapsedSidebarView', () => ({
  CollapsedSidebarView: function CollapsedSidebarView() {
    return React.createElement('CollapsedSidebarView');
  },
}));

vi.mock('expo-router/drawer', () => ({
  Drawer: (props: any) => React.createElement('Drawer', props),
}));

describe('SidebarNavigator (collapsed)', () => {
  it('uses collapsed drawer width and collapsed drawer content when sidebarCollapsed is true', async () => {
    mocks.useAuth.mockReturnValue({ isAuthenticated: true });
    mocks.useIsTablet.mockReturnValue(true);
    mocks.useWindowDimensions.mockReturnValue({ width: 1200, height: 900 });
    mocks.useLocalSetting.mockImplementation((key: string) => (key === 'sidebarCollapsed' ? true : null));

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(SidebarNavigator));
    });

    const drawer = tree!.root.findByType('Drawer' as any);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(72);
    expect(drawer.props.drawerContent?.().type.name).toBe('CollapsedSidebarView');
  });

  it('uses computed drawer width and full SidebarView when sidebarCollapsed is false', async () => {
    mocks.useAuth.mockReturnValue({ isAuthenticated: true });
    mocks.useIsTablet.mockReturnValue(true);
    mocks.useWindowDimensions.mockReturnValue({ width: 1200, height: 900 });
    mocks.useLocalSetting.mockImplementation((key: string) => (key === 'sidebarCollapsed' ? false : null));

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(SidebarNavigator));
    });

    const drawer = tree!.root.findByType('Drawer' as any);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(360);
    expect(drawer.props.drawerContent?.().type.name).toBe('SidebarView');
  });
});

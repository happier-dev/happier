import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
// Boundary: the browser's hardware class (navigator / media queries).
const hardware = vi.hoisted(() => ({ phone: false }));
vi.mock('@/utils/platform/isPhoneHardware', () => ({ isPhoneHardware: () => hardware.phone }));
const { ManagedGetTheAppContent } = await import('./ManagedGetTheAppModal');
afterEach(() => standardCleanup());

describe('ManagedGetTheAppContent (DESIGN-1114 row 17)', () => {
  it('offers a code to scan on a computer', async () => {
    hardware.phone = false;
    const screen = await renderScreen(<ManagedGetTheAppContent onClose={vi.fn()} provider="Railway" />);
    expect(screen.findByTestId('managed-get-the-app.qr')).toBeTruthy();
    expect(screen.findByTestId('managed-get-the-app.open')).toBeFalsy();
    await screen.unmount();
  });

  it('opens the page in the app on a phone instead of asking it to scan itself', async () => {
    hardware.phone = true;
    const screen = await renderScreen(<ManagedGetTheAppContent onClose={vi.fn()} provider="Railway" />);
    expect(screen.findByTestId('managed-get-the-app.qr')).toBeFalsy();
    expect(screen.getTextContent()).not.toContain('Scan with your phone');
    expect(screen.findByTestId('managed-get-the-app.open')).toBeTruthy();
    expect(screen.findByTestId('managed-get-the-app.app-store')).toBeTruthy();
    expect(screen.findByTestId('managed-get-the-app.google-play')).toBeTruthy();
    await screen.unmount();
  });
});

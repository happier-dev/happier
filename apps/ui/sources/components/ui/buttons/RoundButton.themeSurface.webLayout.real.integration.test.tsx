// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: { colors: { button: { primary: {
        gradient: { colors: ['rgb(255, 0, 0)', 'rgb(0, 0, 255)'] },
    } } } } });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View } = await import('react-native');
    const module = createReanimatedModuleMock();
    return { ...module, default: { ...module.default, View } };
});
// Device-local preferences are outside the painted button's owner.
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    sheet?.remove();
    sheet = null;
});

it('lets authored CSS change the same button root that owns its gradient and content geometry', async () => {
    const { RoundButton } = await import('./RoundButton');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<RoundButton title="Save draft" testID="save" onPress={() => {}} />));
    const paintedRoot = host.querySelector<HTMLElement>('[data-surface="button"][data-part="root"]');
    expect(paintedRoot).not.toBeNull();
    expect(paintedRoot!.textContent).toContain('Save draft');
    paintedRoot!.dataset.testid = 'painted-button';
    const before = await measureWebLayout(host, { viewport: { width: 500, height: 200 } });
    expect(before.rect('painted-button').backgroundImage).toContain('linear-gradient');

    sheet = document.createElement('style');
    sheet.textContent = '[data-surface="button"][data-part="root"] { background: rgb(12, 34, 56) !important; padding: 18px 40px !important; }';
    document.head.appendChild(sheet);
    const after = await measureWebLayout(host, { viewport: { width: 500, height: 200 } });
    expect(after.rect('painted-button').backgroundImage).toBe('none');
    expect(after.rect('painted-button').backgroundColor).toBe('rgb(12, 34, 56)');
    expect(after.rect('painted-button').height).toBeGreaterThan(before.rect('painted-button').height);
    expect(after.rect('save').height).toBeGreaterThan(before.rect('save').height);
});

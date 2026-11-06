import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/settings/mcp' }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();

const { useSettingsColumnFilter } = await import('./useSettingsColumnFilter');
const { defineSettingsCollectionAdapter } = await import('./settingsCollectionAdapter');

const adapter = defineSettingsCollectionAdapter(['status', 'machine'] as const);
const row = (key: string, status: string) => ({ key, title: key, status: null, fields: { status: [status], machine: ['m'] } });
const fields = {
    status: { label: 'Status', valueLabel: (value: string) => value },
    machine: { label: 'Machine', valueLabel: (value: string) => value },
};
const render = (facts: readonly ReturnType<typeof row>[]) => renderHook(() => useSettingsColumnFilter({
    column: 'mcp', testIDPrefix: 'test', adapter, fields, facts: facts as never,
} as never));

afterEach(standardCleanup);

describe('useSettingsColumnFilter quick filters', () => {
    it('offers each status the column holds as a one-press chip, which then narrows the rows', async () => {
        const rendered = await render([row('a', 'ready'), row('b', 'off')]);
        const chips = () => rendered.getCurrent().quickFilterChips;
        expect(chips().map((chip) => chip.label).sort()).toEqual(['off', 'ready']);
        await act(async () => { chips().find((chip) => chip.label === 'off')!.onToggle!(); });
        expect(rendered.getCurrent().matches('b')).toBe(true);
        expect(rendered.getCurrent().matches('a')).toBe(false);
        await rendered.unmount();
    });

    it('offers no chip when every row shares one status: it could not narrow anything', async () => {
        const rendered = await render([row('a', 'ready'), row('b', 'ready')]);
        expect(rendered.getCurrent().quickFilterChips).toEqual([]);
        await rendered.unmount();
    });
});

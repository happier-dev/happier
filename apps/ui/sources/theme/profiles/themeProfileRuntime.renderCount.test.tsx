import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from './themeProfilePersistence';
import { applyThemeRuntimeSelection, type ThemeRuntimeUnistylesAdapter } from './themeProfileRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('theme runtime render scope', () => {
    it('batches a mode flip and updates only the visual native theme when its palette changes', async () => {
        const themes: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
        let active: 'light' | 'dark' = 'light';
        let revision = 0;
        let notifications = 0;
        const listeners = new Set<() => void>();
        const notify = () => {
            notifications++;
            for (const listener of listeners) listener();
        };
        const subscribe = (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        };
        const updateTheme = vi.fn<ThemeRuntimeUnistylesAdapter['updateTheme']>((name, updater) => {
            themes[name] = updater(themes[name]);
            revision++;
            notify();
        });
        const runtime: ThemeRuntimeUnistylesAdapter = {
            getTheme: (name) => themes[name],
            updateTheme,
            setAdaptiveThemes: () => {},
            setTheme: (name) => { if (name !== active) { active = name; notify(); } },
            setRootViewBackgroundColor: () => {},
        };
        let themedRenders = 0;
        let plainRenders = 0;
        let themedCommits = 0;
        let plainCommits = 0;
        const Themed = () => {
            React.useSyncExternalStore(subscribe, () => `${active}:${revision}`);
            themedRenders++;
            return null;
        };
        const Plain = () => { plainRenders++; return null; };
        const screen = await renderScreen(
            <>
                <React.Profiler id="themed" onRender={() => { themedCommits++; }}><Themed /></React.Profiler>
                <React.Profiler id="plain" onRender={() => { plainCommits++; }}><Plain /></React.Profiler>
            </>,
        );
        const before = { themedRenders, plainRenders, themedCommits, plainCommits };

        await act(async () => {
            applyThemeRuntimeSelection({
                themePreference: 'dark',
                themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
                systemTheme: 'light',
                platform: 'web',
                unistylesRuntime: runtime,
                setSystemBackgroundColor: () => {},
                recordBreadcrumb: () => {},
            });
        });

        expect(active).toBe('dark');
        expect(updateTheme).not.toHaveBeenCalled();
        expect(notifications).toBe(1);
        expect(themedRenders - before.themedRenders).toBe(1);
        expect(themedCommits - before.themedCommits).toBe(1);
        expect(plainRenders - before.plainRenders).toBe(0);
        expect(plainCommits - before.plainCommits).toBe(0);

        const beforeNative = { themedCommits, plainCommits };
        await act(async () => {
            applyThemeRuntimeSelection({
                themePreference: 'light',
                themeProfiles: { activeProfileIds: { light: 'native', dark: null }, profiles: [{
                    schemaVersion: 1, id: 'native', name: 'Native', createdAt: '2026-11-16', updatedAt: '2026-11-16',
                    base: { light: 'light', dark: 'dark' }, overrides: { light: { 'background.canvas': '#f1e2d3' }, dark: {} },
                }] },
                systemTheme: 'light', platform: 'ios', unistylesRuntime: runtime,
                setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {}, style: null,
            });
        });
        // This adapter measures the host React batch. Native JSI delivery remains a device QA check.
        expect(updateTheme).toHaveBeenCalledTimes(1);
        expect(themes.light.colors.background.canvas).toBe('#f1e2d3');
        expect(active).toBe('light');
        expect(themedCommits - beforeNative.themedCommits).toBe(1);
        expect(plainCommits - beforeNative.plainCommits).toBe(0);
        await screen.unmount();
        standardCleanup();
    });
});

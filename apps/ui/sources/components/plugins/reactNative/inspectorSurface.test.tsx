import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * RN-DOGFOOD — mounts the REAL inspector RN surface source
 * (`packages/plugins/inspector/src/ui/renderSurface.tsx`, relative-imported
 * — same package this repo's `packLocalPlugin`/build tooling ships from,
 * this is a TEST-only cross-package read, not a production dependency) via
 * `react-test-renderer` using apps/ui's OWN established `react-native` web
 * mock (identical pattern to `PluginSurfaceHost.test.tsx`), proving the real
 * component/state machine — list on mount, reload dispatches the SAME
 * canonical `executeAction` shape the generated-V2 host API produces, live-refetch after
 * reload — against a real React tree and real hooks.
 */

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { StyleSheet } = await import('react-native-web');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        StyleSheet,
    });
});

const { renderSurface } = await import('../../../../../../packages/plugins/inspector/src/ui/renderSurface');

function findByTestId(node: ReactTestRenderer, testId: string) {
    return node.root.findAll((instance) => instance.props?.testID === testId);
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
    act(() => {
        renderer?.unmount();
    });
    renderer = null;
    vi.restoreAllMocks();
});

describe('inspector renderSurface (real source, mounted)', () => {
    it('keeps native actions at least 48dp and adapts the surface to RTL high-contrast context', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const executeAction = vi.fn(async () => ({
            ok: true,
            kind: 'plugins_list',
            plugins: [{ id: 'acme.example', pluginId: 'acme.example', state: 'enabled', diagnostics: [] }],
        }));

        await act(async () => {
            renderer = create(renderSurface({
                hostApi: { executeAction },
                surface: {
                    colorScheme: 'dark',
                    contrast: 'high',
                    direction: 'rtl',
                },
            } as never));
            await Promise.resolve();
            await Promise.resolve();
        });

        const [reloadAllButton] = findByTestId(renderer!, 'inspector-reload-all');
        const [reloadPluginButton] = findByTestId(renderer!, 'inspector-reload-acme.example');
        const [pluginRow] = findByTestId(renderer!, 'inspector-plugin-acme.example');
        const [surface] = findByTestId(renderer!, 'inspector-surface');

        expect(reloadAllButton?.props.style).toMatchObject({
            minHeight: 48,
            minWidth: 48,
            backgroundColor: '#ffffff',
        });
        expect(reloadPluginButton?.props.style).toMatchObject({
            minHeight: 48,
            minWidth: 48,
        });
        expect(pluginRow?.props.style).toMatchObject({
            flexDirection: 'row-reverse',
        });
        expect(surface?.props.style).toMatchObject({
            writingDirection: 'rtl',
        });
        expect(surface?.props.style).not.toHaveProperty('direction');
        expect(consoleError.mock.calls.flat().map(String)).not.toContain(
            'Invalid style property of "direction". Did you mean "writingDirection"?',
        );
    });

    it('fetches plugins.list on mount and renders each plugin row', async () => {
        const executeAction = vi.fn(async (actionId: string) => {
            if (actionId === 'plugins.list') {
                return {
                    ok: true,
                    kind: 'plugins_list',
                    plugins: [
                        { id: 'happier.inspector', pluginId: 'happier.inspector', version: '0.0.0', state: 'enabled', diagnostics: [] },
                        { id: 'acme.example', pluginId: 'acme.example', version: '1.2.0', state: 'disabled', diagnostics: [{ code: 'stale_manifest', message: 'Manifest is stale' }] },
                    ],
                };
            }
            throw new Error(`unexpected actionId ${actionId}`);
        });

        await act(async () => {
            renderer = create(renderSurface({ hostApi: { executeAction } } as never));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executeAction).toHaveBeenCalledWith('plugins.list', {});
        expect(findByTestId(renderer!, 'inspector-surface')[0]?.props.style).toMatchObject({
            writingDirection: 'ltr',
        });
        expect(findByTestId(renderer!, 'inspector-plugin-happier.inspector')).toHaveLength(1);
        expect(findByTestId(renderer!, 'inspector-plugin-acme.example')).toHaveLength(1);
    });

    it('reload button dispatches plugins.reload with the pluginId, then live-refetches the list', async () => {
        let listCallCount = 0;
        const executeAction = vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'plugins.list') {
                listCallCount += 1;
                return {
                    ok: true,
                    kind: 'plugins_list',
                    plugins: [{ id: 'acme.example', pluginId: 'acme.example', state: listCallCount > 1 ? 'enabled' : 'disabled', diagnostics: [] }],
                };
            }
            if (actionId === 'plugins.reload') {
                expect(input).toEqual({ pluginId: 'acme.example' });
                return {
                    kind: 'plugins_reload', ok: true, generation: 2,
                    changedPluginIds: ['acme.example'], affectedPluginIds: ['acme.example'],
                    registryStatus: 'ready', diagnostics: [],
                };
            }
            throw new Error(`unexpected actionId ${actionId}`);
        });

        await act(async () => {
            renderer = create(renderSurface({ hostApi: { executeAction } } as never));
            await Promise.resolve();
            await Promise.resolve();
        });

        const [reloadButton] = findByTestId(renderer!, 'inspector-reload-acme.example');
        expect(reloadButton?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'Reload acme.example',
            accessibilityState: { disabled: false },
        });
        await act(async () => {
            (reloadButton!.props as { onPress: () => void }).onPress();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executeAction).toHaveBeenCalledWith('plugins.reload', { pluginId: 'acme.example' });
        expect(listCallCount).toBeGreaterThanOrEqual(2);
        expect(findByTestId(renderer!, 'inspector-last-reload')[0]?.props.accessibilityLiveRegion).toBe('polite');
    });

    it('renders a fail-closed error when hostApi is unavailable, without throwing', async () => {
        await act(async () => {
            renderer = create(renderSurface({} as never));
            await Promise.resolve();
        });

        expect(findByTestId(renderer!, 'inspector-error')[0]?.props).toMatchObject({
            accessibilityRole: 'alert',
            accessibilityLiveRegion: 'assertive',
        });
    });
});

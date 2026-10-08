import * as React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginUiExecuteActionRequestV1Schema, PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createPluginSurfaceHostApi } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { createCanonicalPluginReactNativeHostApiAdapter } from './hostApi';

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
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    const { StyleSheet } = await import('react-native-web');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        StyleSheet,
        ...createCapturingFlatListMock({ renderItems: true }).module,
    });
});

const { renderSurface } = await import('../../../../../../packages/plugins/inspector/src/ui/renderSurface');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');

/** These cases exercise the right-sidebar destination through `surface.mount`. */
const INSPECTOR_TAB_MOUNT = {
    kind: 'destination',
    destination: { pluginId: 'happier.inspector', localId: 'inspector-app' },
    container: 'rightSidebarTab',
} as const;

function createInspectorTabSurface(
    overrides: Parameters<typeof createPluginSurfaceContextFixture>[0] = {},
) {
    return createPluginSurfaceContextFixture({ mount: INSPECTOR_TAB_MOUNT, ...overrides });
}

/**
 * `version()` is a REQUIRED member of the public host API and the documented way
 * a surface negotiates method availability (UI-T04). The right-sidebar tab mount
 * installs no `openSurface`, so the surface renders no page-navigation control
 * in these cases.
 */
const inspectorHostAdapters: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>[] = [];

function createInspectorTabHostApi(executeAction: (actionId: string, input: unknown) => Promise<unknown>) {
    const requestSurface = {
        pluginId: 'happier.inspector', contributionId: 'inspector-app', surfaceId: 'inspector-test',
        placement: 'appSurface' as const, platform: 'ios' as const, channel: 'internal' as const,
        resourceScope: [], diagnostics: [],
    };
    const owner = createPluginSurfaceHostApi({
        surfaceContext: requestSurface,
        handlers: {
            // Only daemon transport is substituted; mounted admission and the
            // public SDK Action transport run through the canonical owners.
            executeAction: async (request) => {
                const payload = PluginUiExecuteActionRequestV1Schema.parse(request.payload);
                if (typeof payload.action !== 'string') throw new Error('Inspector uses local Action ids.');
                return PluginUiJsonValueV1Schema.parse(await executeAction(payload.action, payload.input));
            },
        },
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: createInspectorTabSurface(), requestSurface, requestIdPrefix: 'inspector-test',
        handleRequest: owner.handleRequest, installedMethods: owner.installedMethods,
    });
    inspectorHostAdapters.push(adapter);
    return adapter.api;
}

function renderInspectorSurface(
    context: Omit<Parameters<typeof renderSurface>[0], 'plugin'>,
): React.ReactElement {
    const element = renderSurface({
        plugin: { id: 'happier.inspector', version: '0.0.0' },
        ...context,
    });
    if (!React.isValidElement(element)) {
        throw new Error('Inspector renderSurface must return a React element.');
    }
    return element;
}

function findByTestId(node: ReactTestRenderer, testId: string) {
    return node.root.findAll((instance) => instance.props?.testID === testId);
}

async function findPressableByTestId(node: ReactTestRenderer, testId: string): Promise<ReactTestInstance> {
    let match: ReactTestInstance | undefined;
    await vi.waitFor(() => {
        match = findByTestId(node, testId).find((instance) => typeof instance.props?.onPress === 'function');
        expect(match, `expected ${testId} to name a mounted pressable`).toBeDefined();
    });
    return match!;
}

async function waitForTestId(node: ReactTestRenderer, testId: string): Promise<void> {
    await vi.waitFor(() => {
        expect(findByTestId(node, testId), `expected ${testId} to be mounted`).not.toHaveLength(0);
    });
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
    act(() => {
        renderer?.unmount();
    });
    renderer = null;
    for (const adapter of inspectorHostAdapters.splice(0)) adapter.dispose();
    vi.restoreAllMocks();
});

describe('inspector renderSurface (real source, mounted)', () => {
    it('keeps reload authority adjacent to a selected plugin instead of exposing bulk reload', async () => {
        let listCallCount = 0;
        const executeAction = vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'plugins.list') {
                listCallCount += 1;
                return {
                    ok: true,
                    kind: 'plugins_list',
                    plugins: [{ pluginId: 'acme.example', enabled: true, diagnostics: [] }],
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
            renderer = create(renderInspectorSurface({
                hostApi: createInspectorTabHostApi(executeAction),
                surface: createInspectorTabSurface({
                    colorScheme: 'dark',
                    contrast: 'high',
                    direction: 'rtl',
                }),
            } as never));
            await Promise.resolve();
            await Promise.resolve();
        });

        const pluginRow = await findPressableByTestId(renderer!, 'inspector-plugin-acme.example');
        expect(findByTestId(renderer!, 'inspector-reload-all')).toHaveLength(0);
        expect(pluginRow.props).toMatchObject({
            accessibilityRole: 'option',
            accessibilityLabel: 'acme.example',
        });

        await act(async () => {
            (pluginRow.props as { onPress: () => void }).onPress();
            await Promise.resolve();
        });

        const reloadButton = await findPressableByTestId(renderer!, 'inspector-reload-selected-acme.example');
        expect(reloadButton.props).toMatchObject({
            testID: 'inspector-reload-selected-acme.example',
            title: 'Reload acme.example',
        });
        await act(async () => {
            (reloadButton.props as { onPress: () => void }).onPress();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executeAction).toHaveBeenCalledWith('plugins.reload', { pluginId: 'acme.example' });
        expect(listCallCount).toBeGreaterThanOrEqual(2);
        await waitForTestId(renderer!, 'inspector-last-reload');
    });

    it('renders plugin-supplied translations and falls back per key (§3.2)', async () => {
        // The executable surface resolves its OWN projected bundle: a supplied
        // key renders localized, and a key the bundle does not carry falls back
        // to the author string instead of rendering the raw key.
        const executeAction = vi.fn(async () => ({
            ok: true,
            kind: 'plugins_list',
            plugins: [],
        }));

        await act(async () => {
            renderer = create(renderInspectorSurface({
                hostApi: createInspectorTabHostApi(executeAction),
                surface: createInspectorTabSurface({
                    locale: 'fr',
                    translations: {
                        'plugins.inspector.surface.empty': 'Aucun plugin installé.',
                        'plugins.inspector.surface.refresh': 'Actualiser l’inventaire',
                    },
                }),
            } as never));
            await Promise.resolve();
            await Promise.resolve();
        });

        const quickMenu = findByTestId(renderer!, 'inspector-quick-actions-menu')
            .find((instance) => typeof instance.props.onOpenChange === 'function');
        expect(quickMenu).toBeDefined();
        // A closed menu does not render its portal rows. Assert the translated
        // author-facing Menu item model, not absent native overlay children.
        expect(quickMenu!.props.items).toContainEqual({ id: 'refresh', label: 'Actualiser l’inventaire' });
        const rendered = JSON.stringify(renderer!.toJSON());
        expect(rendered).toContain('Aucun plugin installé.');
        // Untranslated key → the author fallback, never the raw key.
        expect(rendered).toContain('Quick menu');
        expect(rendered).not.toContain('plugins.inspector.surface.empty');
        expect(rendered).not.toContain('plugins.inspector.surface.quickMenu');
    });

    it('fetches plugins.list on mount and renders each plugin row', async () => {
        const executeAction = vi.fn(async (actionId: string) => {
            if (actionId === 'plugins.list') {
                return {
                    ok: true,
                    kind: 'plugins_list',
                    plugins: [
                        { pluginId: 'happier.inspector', version: '0.0.0', enabled: true, diagnostics: [] },
                        { pluginId: 'acme.example', version: '1.2.0', enabled: false, diagnostics: [{ code: 'stale_manifest', message: 'Manifest is stale' }] },
                    ],
                };
            }
            throw new Error(`unexpected actionId ${actionId}`);
        });

        await act(async () => {
            renderer = create(renderInspectorSurface({ hostApi: createInspectorTabHostApi(executeAction), surface: createInspectorTabSurface() } as never));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executeAction).toHaveBeenCalledWith('plugins.list', {});
        await waitForTestId(renderer!, 'inspector-surface');
        await waitForTestId(renderer!, 'inspector-plugin-happier.inspector');
        await waitForTestId(renderer!, 'inspector-plugin-acme.example');
    });

    it('renders a fail-closed error when hostApi is unavailable, without throwing', async () => {
        await act(async () => {
            renderer = create(renderInspectorSurface({
                hostApi: createInspectorTabHostApi(async () => {
                    throw new Error('Host API is unavailable.');
                }),
                surface: createInspectorTabSurface(),
            } as never));
            await Promise.resolve();
        });

        expect(findByTestId(renderer!, 'inspector-error')[0]?.props).toMatchObject({
            tone: 'danger',
            title: 'Plugin inventory unavailable',
            // Unexpected transport failures expose the canonical public code,
            // not the handler's private diagnostic text.
            description: 'internal_error',
        });
    });
});

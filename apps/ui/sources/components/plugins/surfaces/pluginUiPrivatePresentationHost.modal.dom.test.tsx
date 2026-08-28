/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
    PluginUiHostApi,
    PluginUiThemeV1,
    RenderContext,
    SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import type {
    JsonValue,
    PluginCancellationOptions,
    PluginReference,
} from '@happier-dev/plugin-sdk';
import type {
    PluginActionInputById,
    PluginActionResultById,
    PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it, vi } from 'vitest';

import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import { INSPECTOR_SELF_CHECK_ACTION_ID } from '../../../../../../packages/plugins/inspector/src/manifest';
import { renderSurface as renderInspectorSurface } from '../../../../../../packages/plugins/inspector/src/ui/renderSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function unexpectedHostApiCall(method: string): never {
    throw new Error(`Unexpected host API call: ${method}`);
}

function flattenStyle(style: unknown): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<React.CSSProperties>((result, entry) => ({ ...result, ...(flattenStyle(entry) ?? {}) }), {});
    }
    if (typeof style === 'object') return style as React.CSSProperties;
    return undefined;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');

    const View = React.forwardRef<HTMLDivElement, Record<string, any>>(function View(props, ref) {
        const {
            children,
            style,
            testID,
            nativeID,
            pointerEvents: _pointerEvents,
            onLayout: _onLayout,
            collapsable: _collapsable,
            focusable: _focusable,
            accessibilityRole,
            accessibilityLabel,
            accessibilityState: _accessibilityState,
            accessibilityElementsHidden: _accessibilityElementsHidden,
            importantForAccessibility: _importantForAccessibility,
            dataSet: _dataSet,
            ...rest
        } = props;
        return React.createElement('div', {
            ...rest,
            ref,
            id: nativeID,
            role: rest.role ?? accessibilityRole,
            'aria-label': accessibilityLabel,
            'data-testid': testID,
            style: flattenStyle(style),
        }, children);
    });
    const Pressable = React.forwardRef<HTMLButtonElement, Record<string, any>>(function Pressable(props, ref) {
        const {
            children,
            style,
            testID,
            nativeID,
            onPress,
            onPressIn: _onPressIn,
            onLongPress: _onLongPress,
            onHoverIn: _onHoverIn,
            onHoverOut: _onHoverOut,
            accessibilityRole,
            accessibilityLabel,
            accessibilityHint: _accessibilityHint,
            accessibilityState: _accessibilityState,
            hitSlop: _hitSlop,
            ...rest
        } = props;
        return React.createElement('button', {
            ...rest,
            ref,
            id: nativeID,
            role: rest.role ?? accessibilityRole,
            'aria-label': accessibilityLabel,
            'data-testid': testID,
            onClick: onPress,
            style: flattenStyle(typeof style === 'function' ? style({ pressed: false }) : style),
        }, children);
    });

    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: <T,>(values: { web?: T; native?: T; ios?: T; android?: T; default?: T }) => (
                values.web ?? values.default ?? values.native ?? values.ios ?? values.android
            ),
        },
        View,
        Pressable,
        Text: ({
            children,
            selectable: _selectable,
            numberOfLines: _numberOfLines,
            accessibilityLabel,
            testID,
            ...rest
        }: Record<string, unknown>) => React.createElement('span', {
            ...rest,
            'aria-label': accessibilityLabel,
            'data-testid': testID,
        }, children as React.ReactNode),
        Animated: { View },
        StyleSheet: {
            absoluteFillObject: {},
            create: (styles: unknown) => styles,
            flatten: flattenStyle,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

// The composed contract here is Menu -> host-installed provider binding ->
// Popover -> BaseModal. The binding's unrelated markdown/code/icon renderers are static
// siblings, so keep their heavyweight render trees out of this focused test.
vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: () => null,
}));

vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({
    CodeBlockView: () => null,
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: () => null,
}));

vi.mock('@/utils/web/radixCjs', () => ({
    requireRadixDismissableLayer: () => ({
        Branch: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
    }),
}));

vi.mock('@/utils/web/reactDomCjs', async () => {
    const ReactDOM = await import('react-dom');
    return { requireReactDOM: () => ReactDOM };
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', props, props.children)
    ),
}));

const theme: PluginUiThemeV1 = {
    version: 1,
    colors: {
        canvas: '#101010', surface: '#202020', elevatedSurface: '#303030',
        text: '#f0f0f0', secondaryText: '#c0c0c0', mutedText: '#909090',
        border: '#404040', divider: '#353535', focus: '#5599ff',
        accent: '#2277ee', onAccent: '#ffffff',
        success: '#34c759', warning: '#ff9500', danger: '#ff3b30', info: '#5856d6',
        control: '#252525', controlDisabled: '#454545', overlay: 'rgba(0, 0, 0, 0.5)',
    },
    spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 20 },
    radii: { small: 4, control: 8, panel: 12, pill: 999 },
    typography: {
        body: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
        label: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
        title: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
        caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
        code: { fontSize: 12, lineHeight: 16, fontFamily: 'IBMPlexMono-Regular' },
    },
};

function createSurfaceContext(): SurfaceContext {
    return {
        mount: {
            kind: 'embedded',
            role: 'plugin-ui-private-presentation-host-modal-test',
            presentation: 'content',
        },
        target: { kind: 'app' },
        accountEncryptionMode: 'e2ee',
        platform: 'web',
        locale: 'en',
        direction: 'ltr',
        colorScheme: 'dark',
        contrast: 'normal',
        textScale: 1,
        reducedMotion: false,
        screenReaderEnabled: false,
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        theme,
        translations: {},
        targetedContributions: {
            target: {
                pluginId: 'happier.inspector',
                immutableGenerationId: 'presentation-host-modal-test-generation',
            },
            points: [],
        },
    };
}

function createHostApi(
    context: SurfaceContext,
    executeAction: PluginUiHostApi['executeAction'],
): PluginUiHostApi {
    return {
        version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }),
        context: async () => context,
        watchContext: async () => ({ dispose() {} }),
        publishCurrentUiContext: () => unexpectedHostApiCall('publishCurrentUiContext'),
        settleEphemeralInput: async () => unexpectedHostApiCall('settleEphemeralInput'),
        activeComposer: async () => unexpectedHostApiCall('activeComposer'),
        readComposer: async () => unexpectedHostApiCall('readComposer'),
        watchComposer: async () => unexpectedHostApiCall('watchComposer'),
        applyComposer: async () => unexpectedHostApiCall('applyComposer'),
        focusComposer: async () => unexpectedHostApiCall('focusComposer'),
        setComposerDecorations: async () => unexpectedHostApiCall('setComposerDecorations'),
        acquireComposerInputLock: async () => unexpectedHostApiCall('acquireComposerInputLock'),
        pickComposerMedia: async () => unexpectedHostApiCall('pickComposerMedia'),
        inspectComposerContent: async () => unexpectedHostApiCall('inspectComposerContent'),
        releaseComposerContent: async () => unexpectedHostApiCall('releaseComposerContent'),
        executeAction,
        selectActionInput: async () => unexpectedHostApiCall('selectActionInput'),
        readResource: async () => {
            throw new Error('not used by this menu');
        },
        statOpenableContent: async () => unexpectedHostApiCall('statOpenableContent'),
        readOpenableContent: async () => unexpectedHostApiCall('readOpenableContent'),
        watchResource: async () => {
            throw new Error('not used by this menu');
        },
        openSurface: async () => undefined,
        replacePageLocation: async () => unexpectedHostApiCall('replacePageLocation'),
        notify: async () => undefined,
        confirm: async () => false,
        diagnostic: () => undefined,
        readClipboard: async () => '',
        writeClipboard: async () => undefined,
        openExternalLink: async () => undefined,
    };
}

function createInspectorSurfaceHarness() {
    const surface = createSurfaceContext();
    const executeActionSpy = vi.fn<(
        action: PluginReference,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ) => Promise<JsonValue>>(async (action, _input, _options): Promise<JsonValue> => {
        if (action === 'plugins.list') {
            return {
                plugins: [{
                    id: 'inspector',
                    pluginId: 'happier.inspector',
                    title: 'Plugin Inspector',
                    state: 'enabled',
                }],
            } satisfies JsonValue;
        }
        if (action === 'plugins.reload') return { ok: true } satisfies JsonValue;
        if (action === INSPECTOR_SELF_CHECK_ACTION_ID) return { ok: true } satisfies JsonValue;
        return null;
    });
    function executeAction<TActionId extends PluginInvocableActionId>(
        action: TActionId,
        input: PluginActionInputById[TActionId],
        options?: PluginCancellationOptions,
    ): Promise<PluginActionResultById[TActionId]>;
    function executeAction(
        action: PluginReference,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<JsonValue>;
    function executeAction(
        action: PluginReference,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<JsonValue> {
        return executeActionSpy(action, input, options);
    }
    const context = {
        plugin: Object.freeze({ id: 'happier.inspector', version: '1.0.0' }),
        surface,
        hostApi: createHostApi(surface, executeAction),
        signal: new AbortController().signal,
    } satisfies RenderContext;
    const entry = renderInspectorSurface(Object.freeze(context)) as React.ReactElement;
    const boundEntry = React.cloneElement(
        entry as React.ReactElement<Record<string, unknown>>,
        { presentationHost: createPluginUiPrivatePresentationHost({ displayName: 'Plugin Inspector' }) },
    );
    return { boundEntry, executeActionSpy };
}

function countActionCalls(executeAction: ReturnType<typeof vi.fn>, action: string): number {
    return executeAction.mock.calls.filter(([id]) => id === action).length;
}

function popoverElementProps(element: React.ReactNode): Record<string, unknown> {
    if (!React.isValidElement(element)) {
        throw new Error('Expected the private presentation host to return the incumbent Popover element.');
    }
    return element.props as Record<string, unknown>;
}

describe('plugin private presentation carrier in BaseModal', () => {
    it('projects semantic overlay sizing onto the incumbent Popover portal contract', () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const renderPresentation = (presentation: 'popover' | 'menu' | 'dropdown' | 'context') => {
            const input = {
                open: true,
                anchorRef: { current: null } as React.RefObject<unknown>,
                placement: 'bottom' as const,
                presentation,
                onRequestClose: () => {},
                content: () => null,
            };
            return popoverElementProps(host.renderPopover(input));
        };

        expect(renderPresentation('popover').portal).toMatchObject({
            web: true,
            native: true,
            matchAnchorWidth: true,
            anchorAlign: 'start',
        });
        expect(renderPresentation('menu').portal).toMatchObject({
            web: true,
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
        });
        expect(renderPresentation('menu').maxWidthCap).toBe(320);
        expect(renderPresentation('context').portal).toMatchObject({
            web: true,
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
        });
        expect(renderPresentation('context').maxWidthCap).toBe(320);
        expect(renderPresentation('dropdown').portal).toMatchObject({
            web: true,
            native: true,
            matchAnchorWidth: true,
            anchorAlign: 'start',
        });
        expect(renderPresentation('dropdown').maxWidthCap).toBe(1024);
    });

    it('forwards a plugin scroll source to the incumbent Popover without taking over scroll behavior', () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const followScrollRef = { current: null } as React.RefObject<unknown>;
        const input = {
            open: true,
            anchorRef: { current: null } as React.RefObject<unknown>,
            placement: 'bottom' as const,
            onRequestClose: () => {},
            content: () => null,
        };
        // The package-to-host contract is private. This test writes the
        // candidate field dynamically so the missing bridge fails at runtime
        // before its TypeScript declaration is added with the implementation.
        Reflect.set(input, 'followScrollRef', followScrollRef);

        const popover = popoverElementProps(host.renderPopover(input));

        expect(popover.followScrollRef).toBe(followScrollRef);
    });

    it('forwards only the incumbent Popover viewport height to plugin overlay content', () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const content = vi.fn();
        const popover = popoverElementProps(host.renderPopover({
            open: true,
            anchorRef: { current: null } as React.RefObject<unknown>,
            placement: 'bottom',
            onRequestClose: () => {},
            content,
        }));
        const render = popover.children as unknown as (input: Readonly<{
            requestClose(reason: 'selection' | 'escape'): void;
            maxHeight: number;
            maxWidth: number;
            placement: 'top' | 'bottom' | 'left' | 'right';
        }>) => React.ReactNode;
        const requestClose = vi.fn();

        render({ requestClose, maxHeight: 96, maxWidth: 320, placement: 'bottom' });

        expect(content).toHaveBeenCalledExactlyOnceWith({ requestClose, maxHeight: 96 });
    });

    it('mounts the real Inspector menu, context menu, and popover through the incumbent carrier', async () => {
        const { boundEntry, executeActionSpy } = createInspectorSurfaceHarness();
        const outsideTarget = document.createElement('button');
        outsideTarget.type = 'button';
        outsideTarget.textContent = 'Outside target';
        const container = document.createElement('div');
        document.body.append(outsideTarget, container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(boundEntry);
                await Promise.resolve();
            });

            const menuTrigger = document.querySelector<HTMLButtonElement>('[data-testid="inspector-quick-actions-menu"]');
            const popoverTrigger = document.querySelector<HTMLButtonElement>('[data-testid="inspector-self-check-popover"]');
            const contextMenuTrigger = document.querySelector<HTMLButtonElement>('[data-testid="inspector-quick-actions-context-menu"]');
            expect(menuTrigger).not.toBeNull();
            expect(popoverTrigger).not.toBeNull();
            expect(contextMenuTrigger).not.toBeNull();

            const listedBeforeMenuSelection = countActionCalls(executeActionSpy, 'plugins.list');
            await act(async () => {
                menuTrigger?.click();
            });
            const menu = document.querySelector<HTMLElement>('[role="menu"]');
            const menuItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
            expect(menu).not.toBeNull();
            expect(menuItem).not.toBeNull();
            expect(document.activeElement).toBe(menuItem);
            await act(async () => {
                menuItem?.click();
                await Promise.resolve();
            });
            expect(countActionCalls(executeActionSpy, 'plugins.list')).toBeGreaterThan(listedBeforeMenuSelection);
            expect(document.activeElement).toBe(menuTrigger);

            await act(async () => {
                menuTrigger?.click();
                await Promise.resolve();
            });
            expect(document.querySelector('[role="menu"]')).not.toBeNull();
            await act(async () => {
                outsideTarget.focus();
                outsideTarget.dispatchEvent(new MouseEvent('pointerdown', {
                    bubbles: true,
                    cancelable: true,
                }));
                await Promise.resolve();
            });
            expect(document.activeElement).toBe(outsideTarget);

            await act(async () => {
                popoverTrigger?.click();
            });
            const selfCheckDialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Run Inspector self-check"]');
            const selfCheckAction = document.querySelector<HTMLButtonElement>('[data-testid="inspector-self-check-action"]');
            expect(selfCheckDialog).not.toBeNull();
            expect(selfCheckAction).not.toBeNull();
            await act(async () => {
                selfCheckAction?.click();
                await Promise.resolve();
            });
            expect(executeActionSpy).toHaveBeenCalledWith(INSPECTOR_SELF_CHECK_ACTION_ID, undefined, undefined);

            const listedBeforeContextSelection = countActionCalls(executeActionSpy, 'plugins.list');
            await act(async () => {
                contextMenuTrigger?.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                }));
            });
            const contextMenu = document.querySelector<HTMLElement>('[role="menu"]');
            expect(contextMenu).not.toBeNull();
            await act(async () => {
                contextMenu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
                await Promise.resolve();
            });
            expect(countActionCalls(executeActionSpy, 'plugins.list')).toBeGreaterThan(listedBeforeContextSelection);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            outsideTarget.remove();
        }
    });

    it('portals the real Inspector menu into the incumbent modal trap instead of creating a plugin focus owner', async () => {
        const { BaseModal } = await import('@/modal/components/BaseModal');
        const { boundEntry } = createInspectorSurfaceHarness();
        const background = document.createElement('button');
        const container = document.createElement('div');
        document.body.append(background, container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <BaseModal visible closeOnBackdrop={false}>
                        {boundEntry}
                    </BaseModal>,
                );
                await Promise.resolve();
            });

            const trigger = document.querySelector<HTMLButtonElement>('[data-testid="inspector-quick-actions-menu"]');
            await act(async () => {
                trigger?.click();
            });

            const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
            const portalHost = document.querySelector<HTMLElement>('[data-happy-modal-portal-host]');
            const menu = document.querySelector<HTMLElement>('[role="menu"]');
            const menuItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');

            expect(dialog).not.toBeNull();
            expect(portalHost?.contains(menu ?? null)).toBe(true);
            expect(dialog?.contains(menuItem ?? null)).toBe(true);
            expect(trigger).not.toBeNull();
            expect(menuItem).not.toBeNull();

            expect(document.activeElement).toBe(menuItem);

            // The actual Inspector has focusable controls after this trigger,
            // so a browser normally advances there first. Focus the shell's
            // final button to exercise the modal's boundary logic directly:
            // its dynamically opened portal must be the first trapped target.
            const lastFocusable = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []).at(-1);
            expect(lastFocusable).toBeDefined();
            await act(async () => {
                lastFocusable?.focus();
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Tab',
                    bubbles: true,
                    cancelable: true,
                }));
            });
            expect(document.activeElement).toBe(menuItem);
            expect(dialog?.contains(document.activeElement)).toBe(true);
            expect(document.activeElement).not.toBe(background);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            background.remove();
        }
    });
});

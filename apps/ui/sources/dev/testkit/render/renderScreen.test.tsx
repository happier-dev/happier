import * as React from 'react';
import type { TestRendererOptions } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '../hooks/createDeferred';
import { standardCleanup } from '../cleanup/standardCleanup';

afterEach(() => {
    standardCleanup();
});

describe('UI testkit render helpers', () => {
    it('renders screens, finds nodes by test id, and invokes press handlers', async () => {
        const { renderScreen } = await import('./renderScreen');

        const onPress = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                'View',
                { testID: 'root' },
                React.createElement('Pressable', { testID: 'settings.row', onPress }),
                React.createElement('Text', null, 'settings.title'),
            ),
        );

        expect(screen.findByTestId('settings.row')).toBeTruthy();
        expect(screen.getTextContent()).toContain('settings.title');

        screen.pressByTestId('settings.row');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('awaits async press handlers through the screen helper', async () => {
        const { renderScreen } = await import('./renderScreen');

        const events: string[] = [];
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const onPress = vi.fn(async () => {
            events.push('started');
            started.resolve(undefined);
            await release.promise;
            events.push('completed');
        });
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement('Pressable', { testID: 'settings.async', onPress }),
            ),
        );

        let settled = false;
        const pressPromise = screen.pressByTestIdAsync('settings.async').then(() => {
            settled = true;
        });

        await started.promise;
        expect(settled).toBe(false);

        release.resolve(undefined);
        await pressPromise;
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['started', 'completed']);
    });

    it('prefers the actionable host node when a wrapper component shares the same test id', async () => {
        const { renderScreen } = await import('./renderScreen');

        const onPress = vi.fn(async () => undefined);

        function WrappedButton() {
            return React.createElement(
                'Pressable',
                {
                    testID: 'settings.shared-id',
                    onPress,
                    accessibilityLabel: 'wrapped.button',
                },
                React.createElement('Text', null, 'wrapped.button'),
            );
        }

        const screen = await renderScreen(
            React.createElement(WrappedButton, { testID: 'settings.shared-id' } as unknown as Record<string, unknown>),
        );

        expect(screen.findByTestId('settings.shared-id')?.props.accessibilityLabel).toBe('wrapped.button');

        await screen.pressByTestIdAsync('settings.shared-id');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('exposes the same test id helpers on the underlying tree result, including text changes', async () => {
        const { renderScreen } = await import('./renderScreen');

        const onPress = vi.fn();
        const onChangeText = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement('Pressable', { testID: 'settings.tree-row', onPress }),
                React.createElement('TextInput', { testID: 'settings.tree-input', onChangeText }),
            ),
        );

        expect(screen.tree.findByTestId('settings.tree-row')).toBeTruthy();
        screen.tree.pressByTestId('settings.tree-row');
        screen.tree.changeTextByTestId('settings.tree-input', 'next value');

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onChangeText).toHaveBeenCalledWith('next value');
    });

    it('presses a previously-found test instance through the shared standalone helpers', async () => {
        const { pressTestInstance, pressTestInstanceAsync, renderScreen } = await import('./renderScreen');

        const onPress = vi.fn(async () => undefined);
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement('Pressable', { testID: 'settings.instance-row', onPress }),
            ),
        );

        const target = screen.findByTestId('settings.instance-row');
        expect(target).toBeTruthy();

        pressTestInstance(target!, 'settings.instance-row');
        await pressTestInstanceAsync(target!, 'settings.instance-row');

        expect(onPress).toHaveBeenCalledTimes(2);
    });

    it('invokes arbitrary named handlers on a previously-found test instance through the shared standalone helper', async () => {
        const { invokeTestInstanceHandler, renderScreen } = await import('./renderScreen');

        const onPressIn = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement('Pressable', { testID: 'settings.resize-handle', onPressIn }),
            ),
        );

        const target = screen.findByTestId('settings.resize-handle');
        expect(target).toBeTruthy();

        const event = {
            clientX: 320,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        invokeTestInstanceHandler(target!, 'onPressIn', event, 'settings.resize-handle');

        expect(onPressIn).toHaveBeenCalledTimes(1);
        expect(onPressIn).toHaveBeenCalledWith(event);
    });

    it('finds typed instances by nested text content and changes text on a previously-found input instance', async () => {
        const {
            changeTextTestInstance,
            findTestInstanceByTypeContainingText,
            findTestInstanceByTypeWithProps,
            renderScreen,
        } = await import('./renderScreen');

        const onChangeText = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement(
                    'Pressable',
                    { testID: 'review-findings-header:f1' },
                    React.createElement('Text', null, 'Severity: low'),
                    React.createElement('Text', null, 'Original finding'),
                ),
                React.createElement('TextInput', {
                    testID: 'review-findings-follow-up-input',
                    onChangeText,
                }),
            ),
        );

        const header = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Original finding');
        const input = screen.findByTestId('review-findings-follow-up-input');
        const namedInput = findTestInstanceByTypeWithProps(screen.tree, 'TextInput', {
            testID: 'review-findings-follow-up-input',
        });

        expect(header?.props.testID).toBe('review-findings-header:f1');
        expect(input).toBeTruthy();
        expect(namedInput?.props.testID).toBe('review-findings-follow-up-input');

        changeTextTestInstance(input!, 'Please clarify why this matters.', 'review-findings-follow-up-input');

        expect(onChangeText).toHaveBeenCalledWith('Please clarify why this matters.');
    });

    it('proxies common root find helpers onto the underlying tree result', async () => {
        const { renderScreen } = await import('./renderScreen');

        const screen = await renderScreen(
            React.createElement(
                'View',
                { testID: 'settings.root' },
                React.createElement('View', { testID: 'settings.proxy-row' }),
                React.createElement('Text', null, 'settings.proxy-title'),
            ),
        );

        expect(screen.tree.findByType('View')).toBeTruthy();
        expect(screen.tree.findAllByType('View')).toHaveLength(2);
        expect(screen.tree.findByProps({ testID: 'settings.proxy-row' })).toBeTruthy();
        expect(screen.tree.findAllByProps({ testID: 'settings.proxy-row' })).toHaveLength(1);
        expect(screen.tree.find((node) => node.props?.testID === 'settings.proxy-row')).toBeTruthy();
        expect(screen.tree.findAll((node) => typeof node.type === 'string')).not.toHaveLength(0);
    });

    it('exposes the common root find helpers on the screen result itself', async () => {
        const { renderScreen } = await import('./renderScreen');

        const screen = await renderScreen(
            React.createElement(
                'View',
                { testID: 'settings.screen-root' },
                React.createElement('View', { testID: 'settings.screen-row' }),
                React.createElement('Text', null, 'settings.screen-title'),
            ),
        );

        expect(screen.findByType('View')).toBeTruthy();
        expect(screen.findAllByType('View')).toHaveLength(2);
        expect(screen.findByProps({ testID: 'settings.screen-row' })).toBeTruthy();
        expect(screen.findAllByProps({ testID: 'settings.screen-row' })).toHaveLength(1);
        expect(screen.find((node) => node.props?.testID === 'settings.screen-row')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.type === 'string')).not.toHaveLength(0);
    });

    it('collects text content through component wrapper children, not only host props.children', async () => {
        const { renderScreen } = await import('./renderScreen');

        function WrappedLabel() {
            return React.createElement(
                'View',
                null,
                React.createElement('Text', null, 'wrapped.title'),
            );
        }

        const screen = await renderScreen(React.createElement(WrappedLabel));

        expect(screen.getTextContent()).toContain('wrapped.title');
    });

    it('passes createNodeMock through the shared render helper options', async () => {
        const { renderScreen } = await import('./renderScreen');

        const portalHost = { nodeType: 1 };
        const ref = React.createRef<{ nodeType: number } | null>();
        const options: Parameters<typeof renderScreen>[1] & {
            createNodeMock: NonNullable<TestRendererOptions['createNodeMock']>;
        } = {
            createNodeMock: (element) => (
                (element as { props?: { testID?: string } }).props?.testID === 'settings.portal-host' ? portalHost : null
            ),
        };

        await renderScreen(
            React.createElement('View', { testID: 'settings.portal-host', ref }),
            options,
        );

        expect(ref.current).toBe(portalHost);
    });

    it('builds a settings view harness with stable row and group helpers', async () => {
        const { renderSettingsView } = await import('../harness/settingsViewHarness');

        const onBackendPress = vi.fn();
        const onAddPress = vi.fn();

        const screen = await renderSettingsView(
            React.createElement(
                'View',
                null,
                React.createElement('ItemGroup', { title: 'configured' },
                    React.createElement('Item', { testID: 'settings.backend.custom', title: 'Custom Backend', onPress: onBackendPress }),
                ),
                React.createElement('ItemGroup', { title: 'actions' },
                    React.createElement('Item', { testID: 'settings.addBackend', title: 'Add backend', onPress: onAddPress }),
                ),
            ),
        );

        expect(screen.findRow('settings.backend.custom')?.props.title).toBe('Custom Backend');
        expect(screen.findRowByTitle('Custom Backend')?.props.testID).toBe('settings.backend.custom');
        expect(screen.findGroup('configured')).toBeTruthy();
        expect(screen.listRows('settings.')).toHaveLength(2);

        screen.pressRow('settings.addBackend');
        screen.pressRowByTitle('Custom Backend');
        expect(onAddPress).toHaveBeenCalledTimes(1);
        expect(onBackendPress).toHaveBeenCalledTimes(1);
    });

    it('prefers the interactive row when a settings title is shared by a group and an item', async () => {
        const { renderSettingsView } = await import('../harness/settingsViewHarness');

        const onPress = vi.fn();

        const screen = await renderSettingsView(
            React.createElement(
                'View',
                null,
                React.createElement('ItemGroup', { title: 'Duplicate Title' },
                    React.createElement('Item', {
                        testID: 'settings.duplicate',
                        title: 'Duplicate Title',
                        onPress,
                    }),
                ),
            ),
        );

        expect(screen.findRowByTitle('Duplicate Title')?.props.testID).toBe('settings.duplicate');

        screen.pressRowByTitle('Duplicate Title');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('collects unexpected raw text nodes outside allowed parent types', async () => {
        const { collectUnexpectedRawTextNodes } = await import('./renderScreen');
        const tree = {
            type: 'View',
            props: {},
            children: [
                'bad',
                {
                    type: 'Text',
                    props: {},
                    children: ['good'],
                },
            ],
        } as any;

        expect(collectUnexpectedRawTextNodes(tree)).toEqual([
            { parent: 'View', value: 'bad' },
        ]);
    });
});

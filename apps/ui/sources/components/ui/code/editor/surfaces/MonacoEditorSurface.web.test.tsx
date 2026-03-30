import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createModelSpy = vi.fn(() => ({
    getValue: () => '',
    setValue: () => {},
    dispose: () => {},
}));

const createEditorSpy = vi.fn(() => ({
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    onDidBlurEditorText: () => ({ dispose: () => {} }),
    updateOptions: () => {},
    dispose: () => {},
}));

function assertCallable(value: unknown, label: string): (...args: unknown[]) => unknown {
    if (typeof value !== 'function') throw new Error(`expected ${label} to be callable`);
    return value as (...args: unknown[]) => unknown;
}

function setupMonacoGlobals() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).document = (globalThis as any).document ?? {};

    (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
        if (typeof onOk === 'function') onOk();
    };
    (globalThis as any).window.monaco = {
        editor: {
            createModel: createModelSpy,
            create: createEditorSpy,
        },
    };
}

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({}), []);
        return React.createElement('View', props, props.children);
    });
    return createReactNativeWebMock({
        View,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#000',
                text: '#000',
                surfaceHighest: '#fff',
            },
        },
    });
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('../codeEditorFontMetrics', () => ({
    resolveCodeEditorFontMetrics: () => ({ fontSize: 12, lineHeight: 14 }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

import { MonacoEditorSurface } from './MonacoEditorSurface.web';


describe('MonacoEditorSurface (web)', () => {
    it('boots Monaco even when initially not ready', async () => {
        setupMonacoGlobals();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    wrapLines: true,
                    showLineNumbers: true,
                }));

        expect(createModelSpy).toHaveBeenCalledTimes(1);
        expect(createEditorSpy).toHaveBeenCalledTimes(1);
    });

    it('debounces onChange when changeDebounceMs is set', async () => {
        let currentValue = 'start';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        let blurHandler: null | ((..._args: any[]) => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: (handler: (..._args: any[]) => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        const triggerChange = assertCallable(changeHandler, 'change handler');

        currentValue = 'a';
        triggerChange({});
        currentValue = 'ab';
        triggerChange({});
        currentValue = 'abc';
        triggerChange({});

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('abc');
    });

    it('flushes pending debounced change on blur', async () => {
        let currentValue = 'start';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        let blurHandler: null | ((..._args: any[]) => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: (handler: (..._args: any[]) => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        const triggerChange = assertCallable(changeHandler, 'change handler');
        const triggerBlur = assertCallable(blurHandler, 'blur handler');

        currentValue = 'blur-me';
        triggerChange({});

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            triggerBlur({});
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('blur-me');
    });

    it('exposes a stable imperative handle for flush/getValue', async () => {
        const ref = React.createRef<any>();

        let currentValue = 'hello';
        let blurHandler: null | (() => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: (handler: () => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    ref,
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        expect(ref.current).toBeTruthy();
        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.flushPendingChange).toBe('function');
        expect(ref.current.getValue()).toBe('hello');

        currentValue = 'world';
        expect(ref.current.getValue()).toBe('world');

        // Flush should be safe to call even if no timer is pending; blur handler should exist.
        await act(async () => {
            await ref.current.flushPendingChange();
        });
        expect(blurHandler).not.toBeNull();
    });

    it('updates editor readOnly mode when the prop changes after mount', async () => {
        const updateOptionsSpy = vi.fn();

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            editor: {
                createModel: () => ({
                    getValue: () => 'hello',
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: updateOptionsSpy,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        let tree: renderer.ReactTestRenderer;

        tree = (await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }))).tree;

        updateOptionsSpy.mockClear();

        await act(async () => {
            tree!.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
            await flushHookEffects();
        });

        expect(updateOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    });

    it('boots Monaco with the latest readOnly mode when props change before Monaco resolves', async () => {
        const createEditorWithLatestOptionsSpy = vi.fn(() => ({
            onDidChangeModelContent: () => ({ dispose: () => {} }),
            onDidBlurEditorText: () => ({ dispose: () => {} }),
            updateOptions: () => {},
            dispose: () => {},
        }));

        let resolveEditorMain: null | (() => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        delete (globalThis as any).window.monaco;
        (globalThis as any).window.require = Object.assign(
            (deps: any, onOk?: any, _onErr?: any) => {
                if (Array.isArray(deps) && deps[0] === 'vs/editor/editor.main') {
                    resolveEditorMain = () => {
                        (globalThis as any).window.monaco = {
                            editor: {
                                createModel: () => ({
                                    getValue: () => 'hello',
                                    setValue: () => {},
                                    dispose: () => {},
                                }),
                                create: createEditorWithLatestOptionsSpy,
                            },
                        };
                        if (typeof onOk === 'function') onOk();
                    };
                    return;
                }
                if (typeof onOk === 'function') onOk();
            },
            { config: vi.fn() },
        );

        const onChange = vi.fn();
        let tree: renderer.ReactTestRenderer;

        tree = (await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }))).tree;

        await act(async () => {
            tree!.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
            await flushHookEffects();
        });

        expect(createEditorWithLatestOptionsSpy).not.toHaveBeenCalled();

        await act(async () => {
            if (!resolveEditorMain) throw new Error('expected editor main loader callback');
            resolveEditorMain();
            await flushHookEffects();
        });

        expect(createEditorWithLatestOptionsSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ readOnly: false }),
        );
    });
});

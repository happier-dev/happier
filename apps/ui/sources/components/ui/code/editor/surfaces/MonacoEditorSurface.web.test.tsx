import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const defineThemeSpy = vi.fn();
const setThemeSpy = vi.fn();

const darkEditorTheme = {
    dark: true,
    colors: {
        border: { default: '#303030' },
        text: { primary: '#f8f8f2', secondary: '#cfcfcf', tertiary: '#8a8a8a' },
        surface: { base: '#151515', inset: '#1f1f1f', elevated: '#101010', selected: '#2a2a2a' },
        accent: { blue: '#58a6ff' },
        syntax: {
            default: '#f8f8f2',
            keyword: '#ff79c6',
            string: '#50fa7b',
            comment: '#6272a4',
            number: '#bd93f9',
            function: '#8be9fd',
        },
    },
};

const lightEditorTheme = {
    dark: false,
    colors: {
        border: { default: '#d0d7de' },
        text: { primary: '#24292f', secondary: '#57606a', tertiary: '#6e7781' },
        surface: { base: '#ffffff', inset: '#f6f8fa', elevated: '#ffffff', selected: '#ddf4ff' },
        accent: { blue: '#0969da' },
        syntax: {
            default: '#24292f',
            keyword: '#cf222e',
            string: '#0a3069',
            comment: '#6e7781',
            number: '#0550ae',
            function: '#8250df',
        },
    },
};

type EditorThemeFixture = typeof darkEditorTheme | typeof lightEditorTheme;

const unistylesState = vi.hoisted(() => ({
    currentTheme: null as unknown as EditorThemeFixture,
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
            defineTheme: defineThemeSpy,
            setTheme: setThemeSpy,
        },
    };
}

beforeEach(() => {
    createModelSpy.mockClear();
    createEditorSpy.mockClear();
    defineThemeSpy.mockClear();
    setThemeSpy.mockClear();
    unistylesState.currentTheme = darkEditorTheme;
});

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
    const base = await createUnistylesMock();
    const baseRuntime = base.useUnistyles().rt;
    return {
        ...base,
        useUnistyles: () => ({ theme: unistylesState.currentTheme, rt: baseRuntime }),
    };
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

    it('boots Monaco with a theme derived from app theme tokens', async () => {
        setupMonacoGlobals();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        expect(defineThemeSpy).toHaveBeenCalledWith(
            'happier-editor-dark',
            expect.objectContaining({
                base: 'vs-dark',
                inherit: true,
                colors: expect.objectContaining({
                    'editor.background': '#1f1f1f',
                    'editor.foreground': '#f8f8f2',
                    'editorLineNumber.foreground': '#8a8a8a',
                }),
                rules: expect.arrayContaining([
                    expect.objectContaining({ token: 'keyword', foreground: 'ff79c6' }),
                    expect.objectContaining({ token: 'string', foreground: '50fa7b' }),
                    expect.objectContaining({ token: 'comment', foreground: '6272a4' }),
                ]),
            }),
        );
        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark');
        expect(createEditorSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ theme: 'happier-editor-dark' }),
        );
    });

    it('updates the Monaco theme when the app theme changes after mount', async () => {
        setupMonacoGlobals();

        const result = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark');

        unistylesState.currentTheme = lightEditorTheme;
        await act(async () => {
            result.tree.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }),
            );
            await flushHookEffects();
        });

        expect(defineThemeSpy).toHaveBeenLastCalledWith(
            'happier-editor-light',
            expect.objectContaining({
                base: 'vs',
                colors: expect.objectContaining({
                    'editor.background': '#f6f8fa',
                    'editor.foreground': '#24292f',
                }),
            }),
        );
        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-light');
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

    it('keeps unflushed local edits when an external value arrives mid-typing (flushes instead of replacing the doc)', async () => {
        let currentValue = 'seed';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        const setValueSpy = vi.fn((next: string) => {
            currentValue = next;
        });
        const executeEditsSpy = vi.fn((_source: string, edits: Array<{ text: string }>) => {
            currentValue = edits[0]?.text ?? currentValue;
        });

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: currentValue.length + 1 }),
                    setValue: setValueSpy,
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: () => {},
                    executeEdits: executeEditsSpy,
                    getSelections: () => null,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
            resetKey: '1',
            value: currentValue,
            language: 'markdown',
            onChange,
            changeDebounceMs: 100,
        }));

        const triggerChange = assertCallable(changeHandler, 'change handler');

        currentValue = 'local draft';
        triggerChange({});

        await act(async () => {
            screen.tree.update(React.createElement(MonacoEditorSurface, {
                resetKey: '1',
                value: 'external seed',
                language: 'markdown',
                onChange,
                changeDebounceMs: 100,
            }));
        });
        await flushHookEffects();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 125));
        });

        // The user's unflushed local edit is the source of truth: the stale/racing
        // external value must not replace the document (that resets the cursor and
        // loses keystrokes). The pending change is flushed upward so the parent
        // state converges to the editor instead.
        expect(executeEditsSpy).not.toHaveBeenCalled();
        expect(setValueSpy).not.toHaveBeenCalled();
        expect(currentValue).toBe('local draft');
        expect(onChange).toHaveBeenCalledWith('local draft');
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

    it('applies external value changes through editor edits so selection and scroll position are preserved', async () => {
        let currentValue = 'first line\nsecond line';
        const setValueSpy = vi.fn((next: string) => {
            currentValue = next;
        });
        const executeEditsSpy = vi.fn((_source: string, edits: Array<{ text: string }>) => {
            currentValue = edits[0]?.text ?? currentValue;
        });
        const getSelectionsSpy = vi.fn(() => [{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }]);
        const setSelectionsSpy = vi.fn();
        const getScrollTopSpy = vi.fn(() => 42);
        const getScrollLeftSpy = vi.fn(() => 7);
        const setScrollTopSpy = vi.fn();
        const setScrollLeftSpy = vi.fn();

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 12 }),
                    setValue: setValueSpy,
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: () => {},
                    executeEdits: executeEditsSpy,
                    getSelections: getSelectionsSpy,
                    setSelections: setSelectionsSpy,
                    getScrollTop: getScrollTopSpy,
                    getScrollLeft: getScrollLeftSpy,
                    setScrollTop: setScrollTopSpy,
                    setScrollLeft: setScrollLeftSpy,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
            resetKey: '1',
            value: currentValue,
            language: 'markdown',
            onChange,
        }));

        await act(async () => {
            screen.tree.update(React.createElement(MonacoEditorSurface, {
                resetKey: '1',
                value: 'first line\nchanged second line',
                language: 'markdown',
                onChange,
            }));
            await flushHookEffects();
        });

        expect(executeEditsSpy).toHaveBeenCalledWith(
            'happier.external-value',
            [expect.objectContaining({ text: 'first line\nchanged second line' })],
            expect.anything(),
        );
        expect(setValueSpy).not.toHaveBeenCalled();
        expect(setSelectionsSpy).toHaveBeenCalledWith([{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }]);
        expect(setScrollTopSpy).toHaveBeenCalledWith(42);
        expect(setScrollLeftSpy).toHaveBeenCalledWith(7);
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

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    TextInput: ({ children, ...props }: any) => React.createElement('TextInput', props, children),
    Platform: {
        OS: 'web',
        select: (spec: Record<string, unknown>) =>
            spec && Object.prototype.hasOwnProperty.call(spec, 'web') ? (spec as any).web : (spec as any).default,
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                divider: '#ddd',
                text: '#111',
                surfaceHighest: '#fff',
            },
        },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiFontScale') return 2;
        return null;
    },
}));

describe('MonacoEditorSurface (web)', () => {
    it('renders a fallback TextInput when Monaco is unavailable', async () => {
        const { MonacoEditorSurface } = await import('./MonacoEditorSurface.web');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <MonacoEditorSurface
                    resetKey="1"
                    value="hello"
                    language="typescript"
                    onChange={() => {}}
                />,
            );
        });

        const inputs = tree.root.findAllByType('TextInput' as any);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.props.value).toBe('hello');

        const style = inputs[0]!.props.style;
        const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
        expect(flattened.fontSize).toBe(26);
    });

    it('loads Monaco basic languages contributions when Monaco is available', async () => {
        const requireCalls: any[] = [];

        const requireFn: any = (deps: any[], onOk?: any, _onErr?: any) => {
            requireCalls.push(deps);
            if (Array.isArray(deps) && deps.includes('vs/editor/editor.main')) {
                (globalThis as any).window.monaco = {
                    editor: {
                        createModel: () => ({ getValue: () => '', setValue: () => {}, dispose: () => {} }),
                        create: () => ({ onDidChangeModelContent: () => {}, updateOptions: () => {}, dispose: () => {} }),
                    },
                };
            }
            if (typeof onOk === 'function') onOk();
        };
        requireFn.config = () => {};

        const previousWindow = (globalThis as any).window;
        const previousDocument = (globalThis as any).document;

        (globalThis as any).window = { require: requireFn };
        (globalThis as any).document = {};

        const { MonacoEditorSurface } = await import('./MonacoEditorSurface.web');

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <MonacoEditorSurface
                    resetKey="1"
                    value="hello"
                    language="markdown"
                    onChange={() => {}}
                />,
            );
            await Promise.resolve();
        });

        // Cleanup
        renderer.act(() => {
            tree.unmount();
        });
        (globalThis as any).window = previousWindow;
        (globalThis as any).document = previousDocument;

        const flattened = requireCalls.flat();
        expect(flattened).toContain('vs/editor/editor.main');
        expect(flattened).toContain('vs/basic-languages/monaco.contribution');
    });
});

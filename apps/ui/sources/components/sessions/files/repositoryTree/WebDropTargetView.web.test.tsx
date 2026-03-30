/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: any): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<React.CSSProperties>((acc, value) => ({ ...acc, ...(flattenStyle(value) ?? {}) }), {});
    }
    return style;
}

installRepositoryTreeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
            View: React.forwardRef<HTMLDivElement, any>(function View(props, ref) {
                const { children, style, testID, onDragEnter, onDragLeave, onDragOver, onDrop, ...rest } = props;
                void onDragEnter;
                void onDragLeave;
                void onDragOver;
                void onDrop;
                return React.createElement(
                    'div',
                    {
                        ...rest,
                        ref,
                        style: flattenStyle(style),
                        'data-testid': testID,
                    },
                    children,
                );
            }),
            StyleSheet: {
                flatten: flattenStyle,
            },
        });
    },
});

const webDropTargetViewModule = import('./WebDropTargetView');

function createFileDragEvent(type: string): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'] },
        configurable: true,
    });
    return event;
}

describe('WebDropTargetView.web', () => {
    it('bridges native drag and drop events to callbacks even when View does not forward drag props', async () => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const onDragEnter = vi.fn();
        const onDragOver = vi.fn();
        const onDrop = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <WebDropTargetView
                        testID="drop-target"
                        onDragEnter={onDragEnter}
                        onDragOver={onDragOver}
                        onDrop={onDrop}
                    >
                        child
                    </WebDropTargetView>,
                );
            });

            const element = container.firstElementChild;
            expect(element).not.toBeNull();

            element!.dispatchEvent(createFileDragEvent('dragenter'));
            element!.dispatchEvent(createFileDragEvent('dragover'));
            element!.dispatchEvent(createFileDragEvent('drop'));

            expect(onDragEnter).toHaveBeenCalledTimes(1);
            expect(onDragOver).toHaveBeenCalledTimes(1);
            expect(onDrop).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});

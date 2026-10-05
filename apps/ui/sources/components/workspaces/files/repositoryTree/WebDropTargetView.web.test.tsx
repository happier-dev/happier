/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone.web';
import { readRepositoryFileDropTarget } from './repositoryFileDropTarget';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries.web';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const viewRenderSpy = vi.hoisted(() => vi.fn());

function flattenStyle(style: any): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<React.CSSProperties>((acc, value) => ({ ...acc, ...(flattenStyle(value) ?? {}) }), {});
    }
    return style;
}

installRepositoryTreeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('../../../../dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
            View: React.forwardRef<HTMLDivElement, any>(function View(props, ref) {
                viewRenderSpy();
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
    it.each([false, true])('retires a retained pane drag without reviving a stale release (presented again=%s)', async resumed => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const active = vi.fn();
        const dropped = vi.fn();
        function Target() {
            const handlers = useWebFileDropZone({ enabled: true, onFilesDropped: dropped, onFileDragActiveChange: active });
            return <WebDropTargetView {...handlers} />;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const render = (presented: boolean) => root.render(
            <PluginSurfaceFocusEligibilityProvider active={presented}><Target /></PluginSurfaceFocusEligibilityProvider>,
        );
        try {
            await act(async () => render(true));
            const element = container.firstElementChild!;
            await act(async () => element.dispatchEvent(createFileDragEvent('dragenter')));
            await act(async () => render(false));
            if (resumed) await act(async () => render(true));
            await act(async () => element.dispatchEvent(createFileDragEvent('drop')));
            expect(active.mock.calls).toEqual([[true], [false]]);
            expect(dropped).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it.each([true, false])('lets the innermost file target consume once, including refusal (enabled=%s)', async (enabled) => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const outerDrop = vi.fn();
        const innerDrop = vi.fn();
        const active = vi.fn();
        function Target({ inner = false, children }: { inner?: boolean; children?: React.ReactNode }) {
            const handlers = useWebFileDropZone({
                enabled: inner ? enabled : true,
                onFilesDropped: inner ? innerDrop : outerDrop,
                onFileDragActiveChange: active,
            });
            return <WebDropTargetView testID={inner ? 'inner' : 'outer'} {...handlers}>{children}</WebDropTargetView>;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Target><Target inner /></Target>));
            const inner = container.querySelector('[data-testid="inner"]')!;
            await act(async () => {
                inner.dispatchEvent(createFileDragEvent('dragenter'));
                inner.dispatchEvent(createFileDragEvent('drop'));
            });
            expect(innerDrop).toHaveBeenCalledTimes(enabled ? 1 : 0);
            expect(outerDrop).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('retires active file feedback on Escape, browser dragend and unmount', async () => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const active = vi.fn();
        const dropped = vi.fn();
        function Target() {
            const handlers = useWebFileDropZone({ enabled: true, onFilesDropped: dropped, onFileDragActiveChange: active });
            return <WebDropTargetView {...handlers} />;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Target />));
            const element = container.firstElementChild!;
            await act(async () => {
                element.dispatchEvent(createFileDragEvent('dragenter'));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                element.dispatchEvent(createFileDragEvent('drop'));
                element.dispatchEvent(createFileDragEvent('dragenter'));
                window.dispatchEvent(new Event('dragend'));
                element.dispatchEvent(createFileDragEvent('drop'));
                element.dispatchEvent(createFileDragEvent('dragenter'));
                root.unmount();
            });
            expect(active.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);
            expect(dropped).not.toHaveBeenCalled();
        } finally { container.remove(); }
    });

    it('keeps native textarea drops ahead of ancestor native listeners and leaves text drags alone', async () => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const outerDrop = vi.fn();
        const innerDrop = vi.fn();
        function Textarea() {
            const hostRef = React.useRef<HTMLTextAreaElement>(null);
            useWebFileDropZone({ enabled: true, hostRef, onFilesDropped: innerDrop });
            return <textarea ref={hostRef} />;
        }
        function Outer() {
            const handlers = useWebFileDropZone({ enabled: true, onFilesDropped: outerDrop });
            return <WebDropTargetView {...handlers}><Textarea /></WebDropTargetView>;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Outer />));
            const textarea = container.querySelector('textarea')!;
            const textEvent = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(textEvent, 'dataTransfer', { value: { types: ['text/plain'] } });
            await act(async () => {
                textarea.dispatchEvent(textEvent);
                textarea.dispatchEvent(createFileDragEvent('drop'));
            });
            expect(textEvent.defaultPrevented).toBe(false);
            expect(innerDrop).toHaveBeenCalledTimes(1);
            expect(outerDrop).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('uploads directory-relative entries to the currently mounted row even without an earlier hover', async () => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const uploads: { destinationDir: string; relativePath: string }[] = [];
        function Target() {
            const handlers = useWebFileDropZone({ enabled: true, onFilesDropped: async event => {
                const target = readRepositoryFileDropTarget(event)!;
                const entries = await readWebDroppedEntries(event.dataTransfer as DataTransfer);
                uploads.push(...entries.map(entry => ({ destinationDir: target.destinationDir, relativePath: entry.relativePath })));
            } });
            return <WebDropTargetView {...handlers}>
                <WebDropTargetView testID="folder" repositoryFileDropTarget={{ destinationDir: 'src', hoverPath: 'src', autoExpandDirectoryPath: 'src' }}>folder</WebDropTargetView>
            </WebDropTargetView>;
        }
        const file = new File(['hello'], 'readme.txt');
        const directoryEntry = {
            isFile: false, isDirectory: true, name: 'docs',
            createReader() {
                let done = false;
                return { readEntries(callback: (entries: unknown[]) => void) {
                    callback(done ? [] : [{ isFile: true, isDirectory: false, name: file.name, file: (receive: (value: File) => void) => receive(file) }]);
                    done = true;
                } };
            },
        };
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Target />));
            const event = createFileDragEvent('drop');
            // Browser FileSystemEntry API is the genuine OS-directory acquisition boundary.
            Object.defineProperty(event, 'dataTransfer', { value: {
                types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => directoryEntry }],
            } });
            await act(async () => container.querySelector('[data-testid="folder"]')!.dispatchEvent(event));
            expect(uploads).toEqual([{ destinationDir: 'src', relativePath: 'docs/readme.txt' }]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('does not trigger an extra render pass when the host ref attaches on mount', async () => {
        viewRenderSpy.mockClear();
        const { WebDropTargetView } = await webDropTargetViewModule;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(<WebDropTargetView testID="drop-target">child</WebDropTargetView>);
            });

            expect(viewRenderSpy).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

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

    it('removes native drag listeners when the host unmounts', async () => {
        const { WebDropTargetView } = await webDropTargetViewModule;
        const onDrop = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <WebDropTargetView
                        testID="drop-target"
                        onDrop={onDrop}
                    >
                        child
                    </WebDropTargetView>,
                );
            });

            const element = container.firstElementChild as HTMLElement | null;
            expect(element).not.toBeNull();

            await act(async () => {
                root.unmount();
            });

            element!.dispatchEvent(createFileDragEvent('drop'));
            expect(onDrop).not.toHaveBeenCalled();
        } finally {
            container.remove();
        }
    });
});

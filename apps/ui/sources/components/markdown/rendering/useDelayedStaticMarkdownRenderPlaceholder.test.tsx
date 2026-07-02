import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { STATIC_MARKDOWN_RENDER_PLACEHOLDER_DELAY_MS } from './staticMarkdownRenderPlaceholderConfig';
import { useDelayedStaticMarkdownRenderPlaceholder } from './useDelayedStaticMarkdownRenderPlaceholder';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createLayoutEvent(height: number): LayoutChangeEvent {
    return {
        nativeEvent: {
            layout: {
                x: 0,
                y: 0,
                width: 320,
                height,
            },
        },
    } as LayoutChangeEvent;
}

describe('useDelayedStaticMarkdownRenderPlaceholder', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not show the placeholder when content layout reports ready before the passive effect runs', async () => {
        vi.useFakeTimers();
        const visibleValues: boolean[] = [];

        function LayoutReporter(props: Readonly<{ onContentLayout: (event: LayoutChangeEvent) => void }>) {
            React.useLayoutEffect(() => {
                props.onContentLayout(createLayoutEvent(24));
            }, [props.onContentLayout]);
            return null;
        }

        function Harness() {
            const placeholder = useDelayedStaticMarkdownRenderPlaceholder({
                enabled: true,
                contentKey: 'rendered markdown',
            });
            visibleValues.push(placeholder.visible);
            return <LayoutReporter onContentLayout={placeholder.onContentLayout} />;
        }

        await act(async () => {
            renderer.create(<Harness />);
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(STATIC_MARKDOWN_RENDER_PLACEHOLDER_DELAY_MS + 1);
        });

        expect(visibleValues.at(-1)).toBe(false);
    });
});

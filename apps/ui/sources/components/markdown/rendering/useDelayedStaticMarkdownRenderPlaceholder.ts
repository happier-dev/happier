import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';

import {
    STATIC_MARKDOWN_RENDER_PLACEHOLDER_DELAY_MS,
    STATIC_MARKDOWN_RENDER_READY_MIN_HEIGHT,
} from './staticMarkdownRenderPlaceholderConfig';

type UseDelayedStaticMarkdownRenderPlaceholderParams = Readonly<{
    enabled: boolean;
    contentKey: string;
}>;

type UseDelayedStaticMarkdownRenderPlaceholderResult = Readonly<{
    visible: boolean;
    onContentLayout: (event: LayoutChangeEvent) => void;
}>;

export function useDelayedStaticMarkdownRenderPlaceholder(
    params: UseDelayedStaticMarkdownRenderPlaceholderParams,
): UseDelayedStaticMarkdownRenderPlaceholderResult {
    const contentReadyRef = React.useRef(!params.enabled);
    const [visible, setVisible] = React.useState(false);

    React.useEffect(() => {
        if (!params.enabled) {
            contentReadyRef.current = true;
            setVisible(false);
            return;
        }

        contentReadyRef.current = false;
        setVisible(false);

        const timeout = setTimeout(() => {
            if (!contentReadyRef.current) {
                setVisible(true);
            }
        }, STATIC_MARKDOWN_RENDER_PLACEHOLDER_DELAY_MS);

        return () => {
            clearTimeout(timeout);
        };
    }, [params.contentKey, params.enabled]);

    const onContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (!params.enabled) return;
        if (event.nativeEvent.layout.height < STATIC_MARKDOWN_RENDER_READY_MIN_HEIGHT) return;
        contentReadyRef.current = true;
        setVisible(false);
    }, [params.enabled]);

    return { visible, onContentLayout };
}

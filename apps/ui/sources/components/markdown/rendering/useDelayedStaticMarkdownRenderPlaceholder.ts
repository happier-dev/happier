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
    const readyContentKeyRef = React.useRef<string | null>(params.enabled ? null : params.contentKey);
    const [visible, setVisible] = React.useState(false);

    React.useEffect(() => {
        if (!params.enabled) {
            readyContentKeyRef.current = params.contentKey;
            setVisible(false);
            return;
        }

        setVisible(false);

        const timeout = setTimeout(() => {
            if (readyContentKeyRef.current !== params.contentKey) {
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
        readyContentKeyRef.current = params.contentKey;
        setVisible(false);
    }, [params.contentKey, params.enabled]);

    return { visible, onContentLayout };
}

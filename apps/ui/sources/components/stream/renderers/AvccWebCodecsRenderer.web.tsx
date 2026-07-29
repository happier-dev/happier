import * as React from 'react';

import { createBrowserLiveStreamWebCodecsAdapter } from '@/sync/domains/machines/peer/mediation/stream/webCodecs';

import {
    AvccWebCodecsRenderer as SharedAvccWebCodecsRenderer,
    type AvccWebCodecsRendererProps,
} from './AvccWebCodecsRenderer.shared';

type CanvasProps = React.CanvasHTMLAttributes<HTMLCanvasElement> & React.RefAttributes<HTMLCanvasElement> & Readonly<{
    testID: string;
}>;

export type { AvccWebCodecsRendererProps };

export function AvccWebCodecsRenderer(props: AvccWebCodecsRendererProps): React.ReactElement {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const adapter = React.useMemo(
        () => props.adapter ?? createBrowserLiveStreamWebCodecsAdapter({
            getCanvas: () => canvasRef.current,
        }),
        [props.adapter],
    );
    const canvasProps: CanvasProps = {
        ref: (node: HTMLCanvasElement | null) => {
            canvasRef.current = node;
        },
        style: {
            width: '100%',
            height: '100%',
        },
        testID: `${props.testID}-webcodecs-canvas`,
    };

    return (
        <SharedAvccWebCodecsRenderer
            {...props}
            adapter={adapter}
            surface={React.createElement('canvas', canvasProps)}
        />
    );
}

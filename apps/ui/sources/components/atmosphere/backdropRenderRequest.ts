import { snapCanvasBox } from '@/components/ui/media/canvasBackingStore';

import type { BackdropCanvasProps, BackdropRenderRequest } from './backdropCanvas.types';

export function backdropRenderRequest(props: BackdropCanvasProps, dpr: number): BackdropRenderRequest {
    const box = snapCanvasBox(props.size.width, props.size.height, dpr);
    return {
        source: props.source, width: box.pixelWidth, height: box.pixelHeight, focus: props.focus, horizon: props.horizon,
        job: { look: props.look, theme: props.theme, page: props.page, dpr, params: props.params,
            dissolve: props.dissolve, grade: props.grade, adjust: props.adjust, toe: props.toe,
            span: props.span ? { x: props.span.x * dpr, y: props.span.y * dpr, W: props.span.W * dpr, H: props.span.H * dpr } : null },
    };
}

/** Source bytes/identity are owned by the platform cache; all render inputs are included here. */
export function backdropRequestKey(request: BackdropRenderRequest): string {
    const { source: _source, ...configuration } = request;
    return JSON.stringify(configuration);
}

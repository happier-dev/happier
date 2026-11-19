import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { renderBackdrop, type AtmosphereBackdropJob } from '@happier-dev/brand/atmosphere';
import { BackdropCanvas } from '@/components/atmosphere/BackdropCanvas.web';
import type { BackdropCanvasProps } from '@/components/atmosphere/backdropCanvas.types';

const mount = document.getElementById('product');
if (!mount) throw new Error('Missing canvas harness mount');
const root = createRoot(mount);
const pixels = () => {
    const canvas = mount.querySelector('canvas');
    if (!canvas) throw new Error('Missing product canvas');
    return { rgba: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data), w: canvas.width, h: canvas.height };
};

const harness = {
    async backdrop(job: AtmosphereBackdropJob) {
        const props: BackdropCanvasProps = { ...job, source: job.source, size: { width: job.source.w / (job.dpr ?? 1), height: job.source.h / (job.dpr ?? 1) }, testID: 'U4-backdrop' };
        await new Promise<void>((resolve, reject) => root.render(<BackdropCanvas {...props} onReady={resolve} onError={reject} />));
        const drawn = pixels();
        const expected = renderBackdrop(job);
        return { ...drawn, expected: Array.from(expected.rgba) };
    },
    async picture(props: BackdropCanvasProps) {
        await new Promise<void>((resolve, reject) => root.render(<BackdropCanvas {...props} onReady={resolve} onError={reject} />));
        return { w: pixels().w, h: pixels().h };
    },
    async strictBackdrop() {
        const source = { rgba: new Uint8ClampedArray([32, 64, 128, 255]), w: 1, h: 1 };
        const job = { source, look: 'original', theme: 'light', page: [245, 245, 245] } as const;
        await new Promise<void>((resolve, reject) => root.render(<React.StrictMode><BackdropCanvas {...job} size={{ width: 1, height: 1 }} onReady={resolve} onError={reject} /></React.StrictMode>));
        const drawn = pixels();
        const expected = renderBackdrop(job);
        if (drawn.rgba.some((value, index) => value !== expected.rgba[index])) throw new Error('StrictMode canvas drift');
    },
    unmount() { root.unmount(); },
};

declare global { interface Window { U4: typeof harness } }
window.U4 = harness;

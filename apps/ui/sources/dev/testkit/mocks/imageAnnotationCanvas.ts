import { vi } from 'vitest';

/** Browser decode, Canvas and PNG encoding boundary; annotation logic remains real. */
export function installImageAnnotationCanvasBoundary(options?: Readonly<{ width: number; height: number; pixels: Uint8ClampedArray; decodeFailed?: boolean; canvasUnavailable?: boolean }>) {
    let encodes = 0;
    const events: string[] = [];
    const outputs: Uint8ClampedArray[] = [];
    const draws: Array<Readonly<{ kind: 'fill' | 'stroke'; d: string; opacity: number; blendMode: string }>> = [];
    type Pixels = Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>;
    const copy = (from: Pixels, to: Pixels, dx: number, dy: number) => {
        for (let y = 0; y < from.height; y++) for (let x = 0; x < from.width; x++) {
            if (x + dx < 0 || y + dy < 0 || x + dx >= to.width || y + dy >= to.height) continue;
            to.pixels.set(from.pixels.subarray((y * from.width + x) * 4, (y * from.width + x + 1) * 4), ((y + dy) * to.width + x + dx) * 4);
        }
    };
    vi.stubGlobal('Image', class {
        onload?: () => void;
        onerror?: () => void;
        width = options?.width ?? 40;
        height = options?.height ?? 30;
        pixels = options?.pixels.slice() ?? new Uint8ClampedArray(this.width * this.height * 4);
        set src(_uri: string) { queueMicrotask(() => options?.decodeFailed ? this.onerror?.() : this.onload?.()); }
    });
    vi.stubGlobal('Path2D', class { constructor(readonly d: string) {} });
    vi.stubGlobal('OffscreenCanvas', class {
        pixels: Uint8ClampedArray;
        constructor(readonly width: number, readonly height: number) { this.pixels = new Uint8ClampedArray(width * height * 4); }
        getContext() {
            if (options?.canvasUnavailable) return null;
            const raster = this;
            return {
                globalAlpha: 1, globalCompositeOperation: 'source-over',
                drawImage(from: Pixels, dx: number, dy: number) { events.push('drawImage'); copy(from, raster, dx, dy); },
                getImageData(x: number, y: number, width: number, height: number) {
                    events.push('readUntouched');
                    const out = { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
                    copy(raster, out, -x, -y);
                    return { width, height, data: out.pixels };
                },
                putImageData(image: Readonly<{ width: number; height: number; data: Uint8ClampedArray }>, x: number, y: number) {
                    events.push('burnBlur'); copy({ ...image, pixels: image.data }, raster, x, y);
                },
                translate() {}, save() {}, restore() {},
                fill(shape: Readonly<{ d: string }>) { events.push('vectorFill'); draws.push({ kind: 'fill', d: shape.d, opacity: this.globalAlpha, blendMode: this.globalCompositeOperation }); },
                stroke(shape: Readonly<{ d: string }>) { events.push('vectorStroke'); draws.push({ kind: 'stroke', d: shape.d, opacity: this.globalAlpha, blendMode: this.globalCompositeOperation }); },
                fillText() { events.push('text'); }, measureText: () => ({ width: 10 }),
            };
        }
        async convertToBlob() {
            encodes++;
            outputs.push(this.pixels.slice());
            return new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' });
        }
    });
    return { encodeCount: () => encodes, events, outputs, draws };
}

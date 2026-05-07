import type {
    PhotoGradientAvatarModel,
    PhotoGradientRgbColor,
} from './photoGradientTypes';

type RasterCanvasContext = Readonly<{
    createImageData: (width: number, height: number) => ImageData;
    putImageData: (imageData: ImageData, dx: number, dy: number) => void;
}>;

type RasterCanvas = Readonly<{
    width: number;
    height: number;
    getContext: (contextId: '2d') => RasterCanvasContext | null;
    toDataURL: (type?: string, quality?: number) => string;
}>;

export type PhotoGradientRasterEnvironment = Readonly<{
    createCanvas: (width: number, height: number) => RasterCanvas | null;
}>;

type Vec2 = Readonly<{ x: number; y: number }>;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function clampChannel(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function mixChannel(from: number, to: number, amount: number): number {
    return from + ((to - from) * amount);
}

function mixColor(from: PhotoGradientRgbColor, to: PhotoGradientRgbColor, amount: number): PhotoGradientRgbColor {
    const ratio = clamp01(amount);
    return {
        r: mixChannel(from.r, to.r, ratio),
        g: mixChannel(from.g, to.g, ratio),
        b: mixChannel(from.b, to.b, ratio),
    };
}

function pixelHash(x: number, y: number, seed: number): number {
    const value = Math.sin((x * 12.9898) + (y * 78.233) + (seed * 0.0001)) * 43758.5453123;
    return value - Math.floor(value);
}

function valueNoise(x: number, y: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const smoothX = fx * fx * (3 - (2 * fx));
    const smoothY = fy * fy * (3 - (2 * fy));
    const a = pixelHash(ix, iy, seed);
    const b = pixelHash(ix + 1, iy, seed);
    const c = pixelHash(ix, iy + 1, seed);
    const d = pixelHash(ix + 1, iy + 1, seed);
    return mixChannel(
        mixChannel(a, b, smoothX),
        mixChannel(c, d, smoothX),
        smoothY,
    );
}

function applyWarp(model: PhotoGradientAvatarModel, point: Vec2): Vec2 {
    const ratio = model.warpRatio;
    const seedOffset = (model.seed % 997) / 997;
    if (model.warpVariant === 'rows') {
        const row = Math.floor(point.y * 6);
        return {
            x: point.x + (Math.sin(row + seedOffset) * ratio * 0.16),
            y: point.y,
        };
    }
    if (model.warpVariant === 'columns') {
        const column = Math.floor(point.x * 6);
        return {
            x: point.x,
            y: point.y + (Math.sin(column + seedOffset) * ratio * 0.16),
        };
    }
    if (model.warpVariant === 'diagonal') {
        const diagonalAngle = 18 * (Math.PI / 180);
        const diagonalCoordinate = (point.x * Math.cos(diagonalAngle)) + (point.y * Math.sin(diagonalAngle));
        const diagonal = Math.floor(diagonalCoordinate * 6);
        const offset = Math.sin(diagonal + seedOffset) * ratio * 0.12;
        return {
            x: point.x + offset,
            y: point.y + (offset * 0.32),
        };
    }
    if (model.warpVariant === 'waves') {
        return {
            x: point.x,
            y: point.y + (Math.sin((point.x * 8) + seedOffset) * ratio * 0.18),
        };
    }
    if (model.warpVariant === 'oval') {
        const dx = point.x - 0.5;
        const dy = point.y - 0.5;
        const distance = Math.sqrt((dx * dx) + (dy * dy));
        const pull = Math.sin(distance * Math.PI * 2) * ratio * 0.16;
        return {
            x: point.x + (dx * pull),
            y: point.y + (dy * pull),
        };
    }
    if (model.warpVariant === 'valueNoise') {
        const noise = valueNoise(point.x * model.warpSize * 4, point.y * model.warpSize * 4, model.seed) - 0.5;
        return {
            x: point.x + (noise * ratio * 0.22),
            y: point.y - (noise * ratio * 0.18),
        };
    }
    if (model.warpVariant === 'voronoi') {
        let nearestDistance = 1;
        for (const controlPoint of model.points) {
            const dx = point.x - (controlPoint.x / model.size);
            const dy = point.y - (controlPoint.y / model.size);
            nearestDistance = Math.min(nearestDistance, Math.sqrt((dx * dx) + (dy * dy)));
        }
        const push = Math.sin(nearestDistance * 24) * ratio * 0.08;
        return {
            x: point.x + push,
            y: point.y - push,
        };
    }
    return point;
}

function sampleColor(model: PhotoGradientAvatarModel, point: Vec2): PhotoGradientRgbColor {
    const sigma = model.renderMode === 'softBezier' ? 0.38 : 0.25;
    const exponent = model.renderMode === 'softBezier' ? 1.25 : 1.8;
    let totalWeight = 0;
    let color = model.backgroundColor;

    for (const controlPoint of model.points) {
        const dx = point.x - (controlPoint.x / model.size);
        const dy = point.y - (controlPoint.y / model.size);
        const distanceSquared = (dx * dx) + (dy * dy);
        const weight = Math.pow(Math.exp(-distanceSquared / (2 * sigma * sigma)), exponent);
        color = mixColor(color, controlPoint.color, weight / (totalWeight + weight + 0.0001));
        totalWeight += weight;
    }

    if (model.renderMode === 'meshGrid') {
        const grid = (Math.abs(Math.sin(point.x * Math.PI * 5)) + Math.abs(Math.sin(point.y * Math.PI * 5))) * 0.035;
        color = mixColor(color, model.backgroundColor, grid);
    }

    return color;
}

function createDefaultCanvas(width: number, height: number): RasterCanvas | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

export function renderPhotoGradientRasterDataUri(
    model: PhotoGradientAvatarModel,
    environment: PhotoGradientRasterEnvironment = { createCanvas: createDefaultCanvas },
): string | null {
    const canvas = environment.createCanvas(model.size, model.size);
    const context = canvas?.getContext('2d') ?? null;
    if (!canvas || !context) return null;

    const imageData = context.createImageData(model.size, model.size);
    for (let y = 0; y < model.size; y += 1) {
        for (let x = 0; x < model.size; x += 1) {
            const offset = ((y * model.size) + x) * 4;
            const warped = applyWarp(model, {
                x: x / Math.max(1, model.size - 1),
                y: y / Math.max(1, model.size - 1),
            });
            const baseColor = sampleColor(model, warped);
            const grain = (pixelHash(x, y, model.seed) - 0.5) * model.noiseRatio * 255;
            imageData.data[offset] = clampChannel(baseColor.r + grain);
            imageData.data[offset + 1] = clampChannel(baseColor.g + grain);
            imageData.data[offset + 2] = clampChannel(baseColor.b + grain);
            imageData.data[offset + 3] = 255;
        }
    }

    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png', 0.92);
}

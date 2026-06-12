import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'public/images');
const sourcesDir = path.join(root, '.tmp/hero-sources');

const DESKTOP_SRC = path.join(sourcesDir, 'Screenshot_2026-05-27_at_10.08.04-0f1452e1-b77d-4179-9db2-7f0607fb16d4.png');
const MOBILE_SRC = path.join(sourcesDir, 'Simulator_Screenshot_-_iPhone_17_-_2026-05-27_at_08.53.29-be9eb70a-b64b-4241-a597-453f20ce7d1c.png');
const MOBILE_FRAME = path.join(sourcesDir, 'mobile-frame.png');

const CANVAS_W = 3840;
const CANVAS_H = 2160;
const DESKTOP_TARGET_W = 3400; // larger than previous ~2878 content width

// Original mobile frame screen inset (from frame template analysis)
const MOBILE_CANVAS_W = 994;
const MOBILE_CANVAS_H = 2160;
const SCREEN = { left: 97, top: 268, width: 800, height: 1644 };

async function buildDesktop() {
    const resized = await sharp(DESKTOP_SRC)
        .resize(DESKTOP_TARGET_W, null, { fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer();

    const meta = await sharp(resized).metadata();
    const left = Math.round((CANVAS_W - meta.width) / 2);
    const top = 120; // align with prior hero framing (UI sits slightly above center)

    await sharp({
        create: {
            width: CANVAS_W,
            height: CANVAS_H,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: resized, left, top }])
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(path.join(outDir, 'desktop.png'));

    console.log('desktop.png', { canvas: `${CANVAS_W}x${CANVAS_H}`, content: `${meta.width}x${meta.height}`, left, top });
}

async function buildMobile(framePath) {
    const screenRadius = Math.round(48 * (SCREEN.width / 284));

    const screenMask = Buffer.from(
        `<svg width="${SCREEN.width}" height="${SCREEN.height}"><rect x="0" y="0" width="${SCREEN.width}" height="${SCREEN.height}" rx="${screenRadius}" ry="${screenRadius}" fill="white"/></svg>`,
    );

    const screenContent = await sharp(MOBILE_SRC)
        .resize(SCREEN.width, SCREEN.height, { fit: 'cover', position: 'top' })
        .composite([{ input: screenMask, blend: 'dest-in' }])
        .png()
        .toBuffer();

    // Replace only the masked screen area on top of the original phone chrome frame.
    await sharp(framePath)
        .composite([{ input: screenContent, left: SCREEN.left, top: SCREEN.top }])
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(path.join(outDir, 'mobile.png'));

    console.log('mobile.png', { canvas: `${MOBILE_CANVAS_W}x${MOBILE_CANVAS_H}`, screen: SCREEN, screenRadius });
}

async function main() {
    await buildDesktop();
    await buildMobile(MOBILE_FRAME);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

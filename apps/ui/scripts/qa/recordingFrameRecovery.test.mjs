import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// The silent, three-second red/green/blue H.264 vector also feeds the mounted hook regression.
const fixture = new URL('../../sources/dev/testkit/fixtures/media/recording-rgb-3s.mp4', import.meta.url);
const owner = new URL('../../sources/components/workspaces/files/file/videoFrameAccess.ts', import.meta.url);

for (const { name, times, channels } of [
    { name: 'a restored movie presents its decoded final frame for a retained trim beyond media duration', times: [4.071], channels: [2] },
    { name: 'successive paused seeks present fresh red, green and blue pixels without stale frames', times: [0.5, 1.5, 2.5, 0.5], channels: [0, 1, 2, 0] },
]) test(name, async () => {
    const [{ outputFiles }, bytes] = await Promise.all([
        build({ entryPoints: [fileURLToPath(owner)], bundle: true, write: false, format: 'iife', globalName: 'frameAccess' }),
        readFile(fixture),
    ]);
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.addScriptTag({ content: outputFiles[0].text });
        await page.evaluate(({ base64, times }) => {
            const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
            const uri = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
            window.completion = frameAccess.withVideoFrameSource(uri, async controls => {
                const frames = [];
                for (const timeSeconds of times) {
                    const frame = await controls.readFrame({ timeSeconds });
                    const image = new Image();
                    image.src = frame.uri;
                    await image.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = image.width;
                    canvas.height = image.height;
                    const context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0);
                    frames.push({ time: frame.timeSeconds, duration: frame.durationSeconds, width: frame.width,
                        pixel: [...context.getImageData(32, 24, 1, 1).data] });
                }
                return frames;
            }).then(result => { window.result = result; }).finally(() => URL.revokeObjectURL(uri));
        }, { base64: bytes.toString('base64'), times });
        await page.waitForFunction(() => window.result !== undefined);
        const result = await page.evaluate(() => window.result);
        for (const [index, frame] of result.entries()) {
            assert.equal(frame.duration, 3);
            assert.equal(frame.width, 64);
            assert.equal(frame.pixel[3], 255);
            assert.ok(frame.pixel[channels[index]] > 200, `Expected channel ${channels[index]}: ${JSON.stringify(frame)}`);
            if (times[index] > 3) assert.equal(frame.time, 3);
        }
        console.log(JSON.stringify({ decoder: 'Chromium', frames: result }));
    } finally {
        await browser.close();
    }
});

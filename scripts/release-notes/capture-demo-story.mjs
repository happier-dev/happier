#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import sharp from 'sharp';

import { resolveQaUiUrl } from '../qa/resolveQaUiUrl.mjs';

const usage = `Usage: node scripts/release-notes/capture-demo-story.mjs
  --stack-runtime <stack.runtime.json> --cdp <QA browser endpoint>
  --release-id <StoryDeck release ID> --asset <filename.png> --backdrop <image>

Open the QA bed's Home in a dedicated Chromium browser, signed in with the
demo Account. Use HAPPIER_QA_UI_MODE=snapshot for a served bundle. The backdrop
is cropped to a square and the featured Session is fitted inside it. Output:
apps/ui/release-notes/assets/<release-id>/<filename.png>. Use the approved
StoryDeck media key for that release when preparing an asset for publication.`;

const assets = fileURLToPath(new URL('../../apps/ui/release-notes/assets/', import.meta.url));
const requireFromTests = createRequire(new URL('../../packages/tests/package.json', import.meta.url));

async function main() {
    const { values: args } = parseArgs({
        options: {
            'stack-runtime': { type: 'string' },
            cdp: { type: 'string' },
            'release-id': { type: 'string' },
            asset: { type: 'string' },
            backdrop: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (args.help) {
        console.log(usage);
        return;
    }
    if (!args['stack-runtime'] || !args.cdp || !args.backdrop
        || !/^[\w-][\w.-]*$/.test(args['release-id'] ?? '')
        || !/^[\w-][\w.-]*\.png$/.test(args.asset ?? '')) {
        throw new Error(usage);
    }

    const seedPath = join(dirname(args['stack-runtime']), 'qa-bed', 'seed.json');
    const seed = JSON.parse(await readFile(seedPath, 'utf8'));
    const sessionId = seed.demo?.featuredSessionId;
    if (seed.profile !== 'demo' || typeof sessionId !== 'string' || !sessionId) {
        throw new Error('Expected a QA-bed demo seed with a featured Session.');
    }

    const home = new URL(resolveQaUiUrl({
        HAPPIER_QA_UI_MODE: process.env.HAPPIER_QA_UI_MODE,
        HAPPIER_QA_STACK_RUNTIME_JSON_PATH: args['stack-runtime'],
    }));
    const { chromium } = requireFromTests('@playwright/test');
    const browser = await chromium.connectOverCDP(args.cdp);
    let screenshot;
    try {
        const pages = browser.contexts().flatMap(context => context.pages()).filter(page => {
            const url = new URL(page.url());
            return url.origin === home.origin && url.pathname === home.pathname;
        });
        if (pages.length !== 1) throw new Error('Open exactly one Home tab for this QA bed.');
        const [page] = pages;
        const session = new URL(home);
        session.pathname = `/session/${encodeURIComponent(sessionId)}`;
        await page.goto(session.href, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('transcript-chat-list').waitFor();
        await page.getByTestId('agentInput.permissionRequests.fixed').waitFor();
        screenshot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
    } finally {
        // Playwright disconnects from an externally launched browser on close.
        await browser.close();
    }

    const canvasSize = 1200;
    const insetSize = 1080;
    const frame = await sharp(args.backdrop).resize(canvasSize, canvasSize).png().toBuffer();
    const inset = await sharp(screenshot).resize(insetSize, insetSize, { fit: 'inside' }).png().toBuffer();
    const image = await sharp(frame).composite([{ input: inset, gravity: 'centre' }]).png().toBuffer();
    const destination = join(assets, args['release-id'], args.asset);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, image);
    console.log(destination);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

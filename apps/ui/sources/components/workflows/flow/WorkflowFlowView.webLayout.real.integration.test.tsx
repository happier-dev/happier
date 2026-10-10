// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowBlock, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { createDeepWorkflowDefinition } from '../../../../../../packages/protocol/src/workflows/workflowDefinition.testkit';
import { HAPPIER_WORK_MAP_LANE_MIN_WIDTH } from '@happier-dev/plugin-ui/presentation';
import { installWebLayoutBridge, measureWebLayout, resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { WorkflowFlowView } from './WorkflowFlowView';
import { projectWorkflowFlow } from './workflowFlowProjection';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

installWebLayoutBridge();
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

function createLoopDefinition(depth: number): WorkflowDefinitionV1 {
    let body: readonly WorkflowBlock[] = [{ kind: 'step', id: 'leaf', name: 'Write the release notes',
        document: { text: 'Write the notes.', references: [], attachments: [] }, input: [], result: { kind: 'text' } }];
    for (let level = depth; level > 0; level--) {
        body = [{ kind: 'loop', id: `loop-${level}`, name: `Review level ${level}`,
            repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body }];
    }
    return { version: 1, inputs: [], defaults: {}, blocks: body };
}

async function expectSamePixels(actualPath: string, expectedPath: string) {
    const actual = readFileSync(actualPath);
    const expected = readFileSync(expectedPath);
    if (actual.equals(expected)) return;
    // PNG compression bytes are not the pixel contract. Decode using the real browser boundary.
    const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
    try {
        const page = await browser.newPage();
        const comparison = await page.evaluate(async ({ actual, expected }) => {
            const decode = async (data: string) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
            const [a, b] = await Promise.all([decode(actual), decode(expected)]);
            if (a.width !== b.width || a.height !== b.height) return { equal: false, dimensions: [a.width, a.height, b.width, b.height] };
            const pixels = (bitmap: ImageBitmap) => {
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                const context = canvas.getContext('2d')!;
                context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            };
            const ap = pixels(a);
            const bp = pixels(b);
            let changed = 0;
            let first: number | undefined;
            for (let index = 0; index < ap.length; index++) {
                if (ap[index] === bp[index]) continue;
                changed++;
                first ??= index;
            }
            return { equal: changed === 0, changed, firstPixel: first === undefined ? null
                : { x: Math.floor(first / 4) % a.width, y: Math.floor(first / 4 / a.width) } };
        }, { actual: actual.toString('base64'), expected: expected.toString('base64') });
        expect(comparison.equal, JSON.stringify(comparison)).toBe(true);
    } finally { await browser.close(); }
}

async function measureFlow(definition: WorkflowDefinitionV1, viewportWidth: number, screenshotName?: 'deep' | 'shallow' | 'builtin') {
    // The default docked Flow pane is 296px, with the host's 12px content inset.
    // A phone gives the same map the available page width, not a pan/zoom canvas.
    const paneWidth = viewportWidth === 1440 ? 296 : viewportWidth;
    const close1Phase = process.env.HAPPIER_FIN_CLOSE1_SHOTS_PHASE;
    const phase = close1Phase ?? process.env.HAPPIER_FIN_N3DEEP_SHOTS_PHASE;
    // Public UI scripts run from apps/ui; the root runner keeps the checkout cwd.
    const directory = path.resolve(existsSync('apps/ui/package.json') ? '.' : '../..',
        close1Phase ? '.project/tmp/fin-close1' : '.project/tmp/fin-n3deep');
    if (phase) mkdirSync(directory, { recursive: true });
    const screenshotPath = phase && screenshotName ? path.join(directory, `${screenshotName}-${viewportWidth}-${phase}.png`) : undefined;
    const projection = projectWorkflowFlow(definition);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<View testID="flow-pane" style={{ width: paneWidth, padding: 12 }}>
        <WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow" />
    </View>));
    let layout = await measureWebLayout(host, { viewport: { width: viewportWidth, height: 1800 },
        texts: projection.nodes.map(node => node.label), settle: replay => act(replay),
        screenshotPath: screenshotName === 'builtin' ? undefined : screenshotPath });
    if (screenshotName === 'builtin' && screenshotPath) {
        // Capture the measured full outline, including its final otherwise branch; no guessed crop.
        const captureHeight = Math.max(1800, Math.ceil(Math.max(layout.rect('flow-pane').bottom,
            ...projection.nodes.map(node => layout.rect(`flow-node-${node.nodeId}`).bottom + 12))));
        layout = await measureWebLayout(host, { viewport: { width: viewportWidth,
            height: captureHeight },
            texts: projection.nodes.map(node => node.label), settle: replay => act(replay), screenshotPath });
        for (const node of projection.nodes) {
            expect(layout.rect(`flow-node-${node.nodeId}`).bottom, node.label).toBeLessThanOrEqual(captureHeight);
        }
    }
    if (screenshotName === 'shallow' && phase === 'after') {
        // Exact pixels include connectors, frame padding, typography and every shallow pixel.
        await expectSamePixels(screenshotPath!, path.join(directory, `shallow-${viewportWidth}-before.png`));
    }
    return { layout, projection };
}

describe('Flow readability in the actual browser layout (FF-N3DEEP)', () => {
    it.each([1440, 390])('keeps all twenty loop levels and their leaf readable at %spx', async width => {
        const { layout, projection } = await measureFlow(createLoopDefinition(20), width, 'deep');
        const pane = layout.rect('flow-pane');
        expect(projection.nodes).toHaveLength(21);
        for (const node of projection.nodes) {
            const row = layout.rect(`flow-node-${node.nodeId}`);
            expect(row.width, node.label).toBeGreaterThanOrEqual(HAPPIER_WORK_MAP_LANE_MIN_WIDTH);
            expect(row.right, node.label).toBeLessThanOrEqual(pane.right - 12);
            const text = layout.textRects(node.label);
            expect(text, node.label).toHaveLength(1);
            expect(text[0].clipped, node.label).toBe(false);
        }
        for (let level = 2; level <= 20; level++) {
            const rail = layout.rect(`flow-rail-loop-${level}`);
            const childRail = layout.rect(`flow-rail-${level === 20 ? 'leaf' : `loop-${level + 1}`}`);
            expect(childRail.left, `level ${level} keeps its own rail`).toBeGreaterThan(rail.left);
        }
    });
    it.each([1440, 390])('preserves the approved shallow frame anatomy at %spx', async width => {
        const { layout, projection } = await measureFlow(createLoopDefinition(1), width, 'shallow');
        const loop = layout.rect(`flow-node-${projection.nodes[0].nodeId}`);
        const leaf = layout.rect('flow-node-leaf');
        expect(leaf.left - loop.left).toBe(36);
        expect(leaf.width).toBe(loop.width - 36);
    });
    it.each([1440, 390])('keeps deep mixed conditions, parallel branches and loops inside the pane at %spx', async width => {
        const { layout, projection } = await measureFlow(createDeepWorkflowDefinition(20), width);
        const pane = layout.rect('flow-pane');
        for (const node of projection.nodes) {
            const row = layout.rect(`flow-node-${node.nodeId}`);
            expect(row.width, node.nodeId).toBeGreaterThanOrEqual(HAPPIER_WORK_MAP_LANE_MIN_WIDTH);
            expect(row.right, node.nodeId).toBeLessThanOrEqual(pane.right - 12);
        }
        for (const label of new Set(projection.nodes.map(node => node.label))) {
            const texts = layout.textRects(label);
            expect(texts.length, label).toBeGreaterThan(0);
            for (const text of texts) expect(text.clipped, label).toBe(false);
        }
    });
    it.each([1440, 390])('keeps Review & converge readable at the default Flow width at %spx', async width => {
        const builtin = getBuiltinWorkflowCatalogV1().find(entry => entry.id === 'builtin:review-and-converge');
        expect(builtin).toBeDefined();
        const { layout, projection } = await measureFlow(builtin!.definition, width, 'builtin');
        const pane = layout.rect('flow-pane');
        for (const node of projection.nodes) {
            const row = layout.rect(`flow-node-${node.nodeId}`);
            expect(row.width, node.nodeId).toBeGreaterThanOrEqual(HAPPIER_WORK_MAP_LANE_MIN_WIDTH);
            expect(row.right, node.nodeId).toBeLessThanOrEqual(pane.right - 12);
        }
        for (const label of new Set(projection.nodes.map(node => node.label))) {
            const texts = layout.textRects(label);
            expect(texts.length, label).toBeGreaterThan(0);
            for (const text of texts) expect(text.clipped, label).toBe(false);
        }
        // Each Then/Otherwise rail still identifies its owning condition once the
        // side pane runs out of the ordinary indent budget (FF-CLOSE1).
        const branches = projection.nodes.filter(node => (node.kind === 'thenBranch'
            || node.kind === 'otherwiseBranch') && node.depth >= 3 && node.depth <= 6);
        expect(branches.length).toBeGreaterThan(1);
        for (const branch of branches) {
            const rail = layout.rect(`flow-rail-${branch.nodeId}`);
            let ancestor = branch.parentNodeId === null ? undefined : projection.nodesById.get(branch.parentNodeId);
            while (ancestor && ancestor.kind !== 'thenBranch' && ancestor.kind !== 'otherwiseBranch') {
                ancestor = ancestor.parentNodeId === null ? undefined : projection.nodesById.get(ancestor.parentNodeId);
            }
            if (ancestor) expect(rail.left, `${ancestor.nodeId} → ${branch.nodeId}`)
                .toBeGreaterThan(layout.rect(`flow-rail-${ancestor.nodeId}`).left);
        }
    });
});

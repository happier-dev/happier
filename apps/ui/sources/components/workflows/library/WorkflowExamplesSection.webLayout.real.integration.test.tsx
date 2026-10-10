// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

/** The example tiles as a browser lays them out (DESIGN-7 P5, lab `nav-N3`). */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

describe('example tiles, as a browser lays them out', () => {
    it('offers the full Session starter catalog and retains the trigger and exact target when selected', async () => {
        const { WorkflowExamplesSection } = await import('./WorkflowExamplesSection');
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol/workflows/builtins/examples');
        const { readDeviceTimeZone } = await import('../triggers/sessionTriggerForm');
        const onUse = vi.fn();
        const session = { sessionId: 'current-session', machineId: 'current-machine' };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => root!.render(<WorkflowExamplesSection session={session} presentation="list" onUse={onUse} />));
        const buttons = Array.from(host.querySelectorAll('[data-testid$=":use"]'));
        expect(buttons.map(button => button.getAttribute('data-testid'))).toEqual(
            WORKFLOW_STARTER_EXAMPLES_V1.map(example => `workflow-examples:${example.key}:use`),
        );
        expect(onUse).not.toHaveBeenCalled();
        const seeded = WORKFLOW_STARTER_EXAMPLES_V1.find(example => example.triggerSeed?.kind === 'schedule')!;
        if (seeded.triggerSeed?.kind !== 'schedule') throw new Error('Expected a scheduled starter');
        await act(async () => {
            (host!.querySelector(`[data-testid="workflow-examples:${seeded.key}:use"]`) as HTMLElement).click();
        });
        expect(onUse.mock.calls[0]?.[0]).toMatchObject({ key: seeded.key, sessionTarget: session,
            trigger: { ...seeded.triggerSeed, schedule: { ...seeded.triggerSeed.schedule, timezone: readDeviceTimeZone() } } });
        expect(onUse.mock.calls[0]?.[0].definition.defaults.conversation).toEqual({ kind: 'existing_session', ...session });
        await act(async () => {
            (host!.querySelector('[data-testid="workflow-examples:ask-once:use"]') as HTMLElement).click();
        });
        expect(onUse.mock.calls[1]?.[0]).toMatchObject({ key: 'ask-once', sessionTarget: session,
            definition: { defaults: { conversation: { kind: 'existing_session', ...session } } } });
        expect(onUse.mock.calls[1]?.[0].trigger).toBeUndefined();
        // The live Session entry supplies no onUse callback. Its ordinary recipe must use the
        // existing unsaved definition carrier too, rather than lose the Session in a catalog-key route.
        const { router } = await import('expo-router');
        const push = vi.mocked(router.push);
        push.mockClear();
        await act(async () => root!.render(<WorkflowExamplesSection session={session} presentation="list" />));
        expect(push).not.toHaveBeenCalled();
        await act(async () => {
            (host!.querySelector('[data-testid="workflow-examples:ask-once:use"]') as HTMLElement).click();
        });
        const href = push.mock.calls[0]?.[0];
        expect(href).toMatchObject({ pathname: '/workflows/new', params: { definitionDraftSeedId: expect.any(String) } });
        if (!href || typeof href !== 'object' || !('params' in href)) throw new Error('Expected a definition draft route');
        const seedId = href.params?.definitionDraftSeedId;
        if (typeof seedId !== 'string') throw new Error('Expected a definition draft seed id');
        const { peekTempData, getTempData } = await import('@/utils/sessions/tempDataStore');
        const stored = peekTempData<{ seed: import('@/sync/domains/workflows/workflowDefinitionDraftSeed').WorkflowDefinitionDraftSeed }>(seedId);
        expect(stored?.seed).toMatchObject({ sessionTarget: session,
            definition: { defaults: { conversation: { kind: 'existing_session', ...session } } } });
        expect(stored?.seed.trigger).toBeUndefined();
        getTempData(seedId);
        await act(async () => root!.render(<WorkflowExamplesSection session={session} opensDraft={false} presentation="list" onUse={onUse} />));
        expect(Array.from(host.querySelectorAll('[data-testid$=":use"]')).map(button => button.getAttribute('data-testid'))).toEqual(
            WORKFLOW_STARTER_EXAMPLES_V1.filter(example => example.triggerSeed === undefined).map(example => `workflow-examples:${example.key}:use`),
        );
    });
    it('draw each example as the small map on the card\'s paper: whole labels in the regular face, lanes wrap, no empty well (DESIGN-7/9 P5)', async () => {
        const { WorkflowExamplesSection } = await import('./WorkflowExamplesSection');
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol/workflows/builtins/examples');
        const { t, tLoose } = await import('@/text');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(React.createElement(View, { style: { width: 900 } }, React.createElement(WorkflowExamplesSection, { onUse: () => {} })));
        });
        // Every text a map draws, and the face it should be drawn in: a step's name and a fork's lane count
        // are regular words, a structure's own title (Side by side, For each file) stays bold (lab
        // `.wm.sm .wm-c .t`, `.wm-forkhd .tx b`, `.wm-loophd .tx b`).
        const { projectWorkflowFlow } = await import('../flow/workflowFlowProjection');
        const CARD_KINDS = new Set(['step', 'action', 'wait', 'evaluator', 'observedAgent']);
        const expectedFace = new Map<string, 'regular' | 'bold'>();
        for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
            const projection = projectWorkflowFlow(example.definition);
            for (const node of projection.nodes) {
                const element = host.querySelector(`[data-testid="workflow-examples:${example.key}:flow-node-${node.nodeId}"]`);
                // Lane captions keep their own quiet role; this asserts names and structure titles.
                if (element === null || node.kind === 'branch' || node.kind === 'thenBranch' || node.kind === 'otherwiseBranch') continue;
                const texts = Array.from(element.querySelectorAll('*')).map((child) => Array.from(child.childNodes)
                    .filter((text) => text.nodeType === Node.TEXT_NODE).map((text) => text.textContent ?? '').join(''))
                    .filter((own) => own.trim().length > 0);
                texts.forEach((own, index) => expectedFace.set(own, CARD_KINDS.has(node.kind) || index > 0 ? 'regular' : 'bold'));
            }
        }
        const mapTexts = new Set(expectedFace.keys());
        const askOnce = WORKFLOW_STARTER_EXAMPLES_V1.find((example) => example.key === 'ask-once')!;
        const askDescription = tLoose(askOnce.descriptionKey);
        const forkTitle = t('workflows.editor.addParallel');
        const layout = await measureWebLayout(host, {
            viewport: { width: 900, height: 2400 },
            texts: [...mapTexts, askDescription],
            settle: (replay) => act(replay),
        });
        let cards = 0;
        for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
            const band = host.querySelector(`[data-testid="workflow-examples:${example.key}:preview"]`) as HTMLElement | null;
            const sheet = host.querySelector(`[data-testid="workflow-examples:${example.key}"]`) as HTMLElement | null;
            if (band === null || sheet === null) continue;
            // The map stands on the card's own paper, never a filled band of its own.
            expect(['', 'rgba(0, 0, 0, 0)', 'transparent']).toContain(getComputedStyle(band).backgroundColor);
            for (const [id, rects] of layout.rects) {
                if (!id.startsWith(`workflow-examples:${example.key}:flow-node-`)) continue;
                const node = rects[0]!;
                // Side-by-side lanes split the map's width; a card in one is the narrow kind.
                const inLane = node.width < layout.rect(`workflow-examples:${example.key}:preview`).width * 0.6;
                cards += 1;
                // A small-map card is one line (lab `.wm.sm .wm-node`: 34 px); a narrow lane card may take
                // two lines rather than cut its name (lab `@container (max-width: 200px)`).
                expect(node.height, id).toBeLessThanOrEqual(inLane ? 44 : 36);
            }
        }
        expect(cards).toBeGreaterThan(4);
        for (const text of mapTexts) {
            for (const rect of layout.textRects(text)) {
                // A label is read whole: never cut to "Review tests and ed…" (DESIGN-9 P5).
                expect(rect.clipped, text).toBe(false);
                // Node labels and a fork's lane count are regular-weight words; only a fork's own title is bold
                // (lab `.wm.sm .wm-c .t`, `.wm-forkhd .tx b`).
                // Happier's weight is its face (`Inter-SemiBold`); the fallback after `var()` names it.
                if (expectedFace.get(text) === 'bold') expect(rect.fontFamily, text).toMatch(/SemiBold|Bold/u);
                else expect(rect.fontFamily, text).not.toMatch(/SemiBold|Bold/u);
            }
        }
        // The fork's title is its own bold word, its lane count a separate regular one.
        expect(expectedFace.get(forkTitle)).toBe('bold');
        expect([...expectedFace].some(([text, face]) => face === 'regular' && /\u00b7/u.test(text))).toBe(true);
        // A one-step example sits in the middle of the paper its taller neighbour gives it, not on top of an
        // empty well (DESIGN-9 P5 "Ask once").
        const description = layout.textRects(askDescription)[0]!;
        const answer = layout.rect('workflow-examples:ask-once:flow-node-ask');
        const use = layout.rect('workflow-examples:ask-once:use');
        expect(Math.abs((answer.top - description.bottom) - (use.top - answer.bottom))).toBeLessThanOrEqual(16);
    });
});

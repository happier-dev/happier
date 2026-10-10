// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

/**
 * The document's geometry as a browser lays it out: real react-native-web output measured in
 * Chromium (`measureWebLayout`), never style values read back from a host renderer. Lane tests that
 * read styles passed while the live page broke (DESIGN-6 M2, DESIGN-7 M2).
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
// A phone browser: the primary pointer is a finger (no hover). This is the platform boundary the
// touch floor reads once at module load.
const pointer = vi.hoisted(() => ({ coarse: true }));
vi.mock('@/utils/platform/webMobileHeuristics', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isCoarsePrimaryPointerEnvironment: () => pointer.coarse,
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
// The composer host is the boundary: a card of a fixed height stands in for it, so the rhythm
// around it is the editor's own.
vi.mock('@/components/sessions/agentInput', async () => {
    const { View: WebView } = await import('react-native-web');
    return {
        AgentInput: (props: Readonly<{ composerRef?: { blockId?: string } }>) => React.createElement(WebView, {
            testID: `composer:${props.composerRef?.blockId ?? 'unknown'}`,
            style: { height: 120, borderWidth: 1, borderColor: 'black', borderRadius: 12 },
        }),
    };
});
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'idle', inputs: null }),
}));
vi.mock('@/components/plugins/surfaces/PluginContextualResourceStoreProvider', () => ({
    PluginContextualResourceStoreProvider: (props: Readonly<{ children?: React.ReactNode }>) =>
        React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/sync/domains/workflows/workflowDefinitionActions', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listWorkflowDefinitions: async () => ({ definitions: [] }),
}));

// Owners that size themselves from `onLayout` read the browser's boxes (names sized to their words).
installWebLayoutBridge();
const settle = (replay: () => Promise<void>) => act(replay);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const MACHINE_SCOPE = { kind: 'machine' as const, machineId: 'machine-1', serverId: 'server-a', directory: '/repo', machineHomeDir: '/Users/me' };

function step(id: string, name: string, text: string) {
    return { kind: 'step' as const, id, name, document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
}

async function renderDocument(blocks: readonly unknown[], width: number, selectedBlockId: string | null = null) {
    const editor = await import('./WorkflowBlockListEditor');
    const drafts = await import('@/sync/domains/workflows/workflowEditorDraft');
    const edits = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
    const authoring = await import('@/sync/domains/workflows/workflowAuthoring');
    const custody = await import('@/components/sessions/authoring/authoringComposerCustody');
    const draft = edits.setWorkflowDefaultField(
        drafts.createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Release', blocks: blocks as never }),
        'agentTarget', AGENT_TARGET,
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(View, { style: { width } }, React.createElement(editor.WorkflowBlockListEditor, {
            draft, list: { kind: 'root' }, blocks: draft.blocks, depth: 0,
            composerScope: MACHINE_SCOPE,
            composerCustody: custody.createWorkflowAuthoringComposerCustody(draft.draftId),
            selectedBlockId,
            validation: authoring.validateWorkflowEditorDraft(draft),
            onChange: () => {}, onSelect: () => {}, onCustomize: () => {},
        })));
    });
    return host;
}

/** Where a block's heading starts reading: its ordinal ring (a leaf) or kind mark (a container). */
function headingMark(layout: Awaited<ReturnType<typeof measureWebLayout>>, labelTestId: string) {
    return layout.rects.get(`${labelTestId}-ordinal`)?.[0] ?? layout.rect(`${labelTestId}-ordinal-mark`);
}

const centre = (rect: Readonly<{ top: number; height: number }>) => rect.top + rect.height / 2;
/** A lane caption's line (`Typography.rowMeta`, web). */
const LANE_LINE = 16;

async function measureRhythm(width: number) {
    const container = await renderDocument([
        step('gather', 'Gather changes', 'Gather the changes since the last tag.'),
        step('write', 'Write changelog', 'Write the changelog.'),
        { kind: 'if', id: 'gate', when: { kind: 'exists', value: { kind: 'result', producer: { blockId: 'write', scope: { kind: 'current' } }, path: [] } },
            then: [step('fix', 'Fix it', 'Fix one thing.')], otherwise: [] },
    ], width);
    return measureWebLayout(container, { viewport: { width, height: 1600 }, texts: ['If it succeeds'], settle });
}

function expectDocumentRhythm(layout: Awaited<ReturnType<typeof measureWebLayout>>, range: Readonly<{ min: number; max: number }>) {
    const captions = layout.textRects('If it succeeds');
    for (const [card, next, caption] of [
        ['composer:gather', 'workflow-editor-step-write-label', captions[0]],
        ['composer:write', 'workflow-editor-if-gate-label', captions[1]],
    ] as const) {
        const cardBottom = layout.rect(card).bottom;
        const mark = headingMark(layout, next);
        // Card to the next heading reads as one step of the document's rhythm (lab P1 ≈ 45 px with
        // its "Returns" line), not a stacked band per edge (DESIGN-7: 93 px).
        expect(mark.top - cardBottom).toBeGreaterThanOrEqual(range.min);
        expect(mark.top - cardBottom).toBeLessThanOrEqual(range.max);
        // The edge's caption sits inside that gap, clear of the card and of the heading it leads to.
        expect(caption).toBeDefined();
        expect(caption!.top).toBeGreaterThanOrEqual(cardBottom + 2);
        expect(caption!.bottom).toBeLessThanOrEqual(mark.top);
    }
}

function expectHeadingsLevel(layout: Awaited<ReturnType<typeof measureWebLayout>>) {
    // The name reads level with its ordinal (DESIGN-7 N28: about 9 px high on a phone).
    for (const id of ['gather', 'write']) {
        const ring = layout.rect(`workflow-editor-step-${id}-label-ordinal`);
        const name = layout.rect(`workflow-editor-step-${id}-label`);
        expect(Math.abs(centre(name) - centre(ring))).toBeLessThanOrEqual(2);
    }
}

describe('the document rhythm, as a browser lays it out', () => {
    it('keeps a phone document at the lab rhythm, with each edge caption inside its gap (DESIGN-7 M2, N28)', async () => {
        const layout = await measureRhythm(390);
        expectDocumentRhythm(layout, { min: 24, max: 48 });
        expectHeadingsLevel(layout);
    });

    it('keeps the desktop document at the same rhythm under a precise pointer', async () => {
        pointer.coarse = false;
        vi.resetModules();
        try {
            const layout = await measureRhythm(900);
            expectDocumentRhythm(layout, { min: 20, max: 40 });
            expectHeadingsLevel(layout);
        } finally {
            pointer.coarse = true;
            vi.resetModules();
        }
    });
});

describe('a typed card, as a browser lays it out', () => {
    it('insets its foot from the bottom border as it does from the sides (DESIGN-7 N30)', async () => {
        pointer.coarse = false;
        vi.resetModules();
        try {
            const container = await renderDocument([
                { kind: 'action', id: 'notify', name: 'Announce it', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Release notes are ready' } } },
            ], 900);
            const layout = await measureWebLayout(container, { viewport: { width: 900, height: 900 }, texts: ['Action · no agent turn'], settle });
            const card = layout.rect('workflow-editor-action-notify-card');
            const [note] = layout.textRects('Action · no agent turn');
            expect(note).toBeDefined();
            const side = note!.left - card.left;
            const bottom = card.bottom - note!.bottom;
            expect(Math.abs(bottom - side)).toBeLessThanOrEqual(3);
        } finally {
            pointer.coarse = true;
            vi.resetModules();
        }
    });
});

describe('a lane, as a browser lays it out', () => {
    it('keeps a lane\'s caret and tick on its name\'s first line, right after its words (DESIGN-7 M1 d)', async () => {
        const container = await renderDocument([
            { kind: 'parallel', id: 'panel', failurePolicy: 'fail_stop', branches: [
                { id: 'one', name: 'Changelog', blocks: [step('a', 'A', 'Draft the changelog.')] },
                { id: 'two', name: 'Issues, edge cases and regressions found while preparing the release notes', blocks: [step('b', 'B', 'Check the issues.')] },
            ] },
        ], 390);
        const layout = await measureWebLayout(container, { viewport: { width: 390, height: 900 }, settle });
        for (const lane of ['one', 'two']) {
            const name = layout.rect(`workflow-editor-parallel-panel-branch-${lane}-label`);
            const caret = layout.rect(`workflow-editor-parallel-panel-branch-${lane}-actions`);
            // The name's first line: its box starts at its text (no vertical padding), one caption line tall.
            const firstLine = name.top + LANE_LINE / 2;
            expect(Math.abs(centre(caret) - firstLine)).toBeLessThanOrEqual(2);
            expect(Math.abs(layout.rect(`workflow-editor-parallel-panel-branch-${lane}-label-tick`).top - firstLine)).toBeLessThanOrEqual(2);
            // The caret's glyph starts within a few pixels of the name's box (its button is wider than its glyph).
            expect(caret.left + (caret.width - 14) / 2 - name.right).toBeLessThanOrEqual(8);
        }
        expect(layout.rect('workflow-editor-parallel-panel-branch-two-label').height).toBeGreaterThan(LANE_LINE);
    });
});

describe('a typed card on a phone, as a browser lays it out', () => {
    it('keeps each label with its value and the pairs apart (DESIGN-7 N5)', async () => {
        const container = await renderDocument([
            { kind: 'workflow', id: 'review', name: 'Review the release', workflowRef: 'builtin:review-and-converge', input: {
                apply: { kind: 'literal', value: 'report' } } },
        ], 360);
        const layout = await measureWebLayout(container, { viewport: { width: 360, height: 1200 }, settle,
            texts: ['Rounds before stopping', '3', 'Apply', 'Report only'] });
        const [roundsLabel] = layout.textRects('Rounds before stopping');
        const [roundsValue] = layout.textRects('3');
        const [applyLabel] = layout.textRects('Apply');
        const withinPair = roundsValue!.top - roundsLabel!.bottom;
        const betweenPairs = applyLabel!.top - roundsValue!.bottom;
        // The narrow card puts each value under its label (07 "Phones recompose")...
        expect(roundsValue!.top).toBeGreaterThan(roundsLabel!.top);
        // ...and a pair reads as one thing: the value right under its label, the next pair clearly
        // further away (lab P1), never an alternating list (DESIGN-7: 30 px within, 45 between).
        expect(withinPair).toBeLessThanOrEqual(6);
        expect(betweenPairs).toBeGreaterThanOrEqual(withinPair + 8);
    });
});

describe('Notify me\'s reported-only toggle, as a browser lays it out', () => {
    it('starts on the card\'s label column like every other row (DESIGN-7 N5)', async () => {
        pointer.coarse = false;
        vi.resetModules();
        try {
            const container = await renderDocument([
                step('gather', 'Gather', 'Gather the changes.'),
                { kind: 'action', id: 'notify', name: 'Announce it', actionId: 'notifications.notify_me', input: {
                    message: { kind: 'result', producer: { blockId: 'gather', scope: { kind: 'current' } }, path: [] } } },
            ], 900);
            const layout = await measureWebLayout(container, { viewport: { width: 900, height: 900 }, settle,
                texts: ['Message', 'Only if the agent reported something'] });
            const [message] = layout.textRects('Message');
            const [toggle] = layout.textRects('Only if the agent reported something');
            expect(Math.abs(toggle!.left - message!.left)).toBeLessThanOrEqual(1);
        } finally {
            pointer.coarse = true;
            vi.resetModules();
        }
    });
});

describe('a container heading on a phone, as a browser lays it out', () => {
    it('moves a long sentence under its name without a leading "·" and never cuts a token (DESIGN-7 N34)', async () => {
        const container = await renderDocument([
            { kind: 'loop', id: 'panel', name: 'Review with a panel', body: [step('lane', 'Lane', 'Review it.')],
                repetition: { kind: 'items', items: { kind: 'input', name: 'reviewEngines' }, maxConcurrent: 2 } },
        ], 390);
        const layout = await measureWebLayout(container, { viewport: { width: 390, height: 900 }, settle });
        const name = layout.rect('workflow-editor-loop-panel-label');
        const meta = layout.rect('workflow-editor-loop-panel-label-meta');
        // The sentence moved beneath the name on this narrow line...
        expect(meta.top).toBeGreaterThanOrEqual(name.bottom - 2);
        // ...so it starts with its own words, not a separator, and shows its whole token.
        expect(meta.text?.trim().startsWith('·')).toBe(false);
        expect(meta.clipped).toBe(false);
    });
});

describe('selecting a step, as a browser lays it out', () => {
    it('moves nothing: the step footer carries only facts, selected or at rest (DESIGN-7 N27)', async () => {
        pointer.coarse = false;
        vi.resetModules();
        try {
            const blocks = [step('plain', 'Plain', 'Write the notes.'), step('next', 'Next', 'Publish them.')];
            const measureNext = async (selected: string | null) => {
                const container = await renderDocument(blocks, 900, selected);
                const layout = await measureWebLayout(container, { viewport: { width: 900, height: 900 }, settle });
                const top = layout.rect('workflow-editor-step-next-label-ordinal').top;
                await act(async () => root?.unmount());
                root = null;
                host?.remove();
                host = null;
                return top;
            };
            const atRest = await measureNext(null);
            const selected = await measureNext('plain');
            expect(selected).toBe(atRest);
        } finally {
            pointer.coarse = true;
            vi.resetModules();
        }
    });
});

describe('a step with issue lines, as a browser lays it out', () => {
    it('keeps the next edge caption as clear of its issue lines as of a card edge (DESIGN-9 N48)', async () => {
        pointer.coarse = false;
        vi.resetModules();
        try {
            const clearance = async (firstText: string, last: string) => {
                const container = await renderDocument([step('gather', 'Gather changes', firstText), step('write', 'Write changelog', 'Write it.')], 900);
                const layout = await measureWebLayout(container, { viewport: { width: 900, height: 900 }, texts: ['If it succeeds'], settle });
                const caption = layout.textRects('If it succeeds')[0]!;
                const above = (layout.rects.get(last) ?? []).at(-1) ?? layout.rect(last);
                await act(async () => root?.unmount());
                root = null;
                host?.remove();
                host = null;
                return caption.top - above.bottom;
            };
            const fromCard = await clearance('Gather the changes since the last tag.', 'composer:gather');
            // An unwritten prompt is an issue: its line is the last thing the step shows.
            const fromIssue = await clearance('', 'workflow-editor-step-gather-issue');
            // A text line has no edge: its group ends with the block's own room (margins.xs), so the
            // caption clears the text by more than it clears a card's border (live: about 4 px of ink).
            expect(fromIssue).toBeGreaterThanOrEqual(fromCard + 4);
        } finally {
            pointer.coarse = true;
            vi.resetModules();
        }
    });
});

describe('setting a card value in a browser', () => {
    it('moves focus into the value it just opened, which says what goes in it (DESIGN-9 N5)', async () => {
        const editor = await import('./WorkflowBlockListEditor');
        const drafts = await import('@/sync/domains/workflows/workflowEditorDraft');
        const edits = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
        const authoring = await import('@/sync/domains/workflows/workflowAuthoring');
        const custody = await import('@/components/sessions/authoring/authoringComposerCustody');
        const initial = edits.setWorkflowDefaultField(
            drafts.createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Release', blocks: [
                { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: {} },
            ] as never }),
            'agentTarget', AGENT_TARGET,
        );
        const composerCustody = custody.createWorkflowAuthoringComposerCustody(initial.draftId);
        function Document() {
            const [draft, setDraft] = React.useState(initial);
            const [selected, setSelected] = React.useState<string | null>(null);
            return React.createElement(View, { style: { width: 900 } }, React.createElement(editor.WorkflowBlockListEditor, {
                draft, list: { kind: 'root' }, blocks: draft.blocks, depth: 0,
                composerScope: MACHINE_SCOPE, composerCustody, selectedBlockId: selected,
                validation: authoring.validateWorkflowEditorDraft(draft),
                onChange: (next: typeof draft) => setDraft(next), onSelect: setSelected, onCustomize: () => {},
            }));
        }
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => root!.render(React.createElement(Document)));
        const set = host.querySelector<HTMLElement>('[data-testid="workflow-editor-action-notify-field-message-set"]');
        expect(set).not.toBeNull();
        await act(async () => { set!.focus(); set!.click(); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        const well = host.querySelector<HTMLElement>('[data-testid="workflow-editor-action-notify-field-message-literal"]');
        expect(well).not.toBeNull();
        // The pressed "+ Set" is gone; focus lands in the value, never on the page body.
        expect(document.activeElement).toBe(well);
        expect(well!.getAttribute('placeholder')).toBeTruthy();
    });
});

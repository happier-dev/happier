// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TRIAGE_UNREAD_ACTIONS_V1 } from './actionsCommand.js';
import {
    TRIAGE_ACTIONS_EDITOR_SCROLL_TEST_ID_V1,
    TriageActionsEditor,
} from './ActionsEditor.js';
import type { TriageMountedActionsV1 } from './useTriageActions.js';

/**
 * Reaching the end of the action a person is writing.
 *
 * The editor mounts inside the shell's clipped work region (`ui/shell/root.tsx`
 * gives the Screen, the fill row and the list region `overflow: hidden`), above
 * a list that owns its own virtualized scroll. The draft is a long sequence of
 * fields with **Save** and **Cancel** last, so on a short viewport, at a large
 * type size, or with a longer action catalog above it, the bottom of the form —
 * including the control that commits it — fell outside the clipped region with
 * no way to scroll to it. The work could be typed and not finished.
 *
 * The editor therefore owns ONE bounded scrolling region of its own. Its own,
 * because the list's virtualizer must keep the scroll it owns: a second
 * same-axis scroller wrapped around the list is the fix that breaks reveal,
 * measurement and keyboard paging for two thousand rows.
 *
 * Exact geometry at 375×667 and at the largest type size is a loaded-runtime
 * gate; what is asserted here is the structural fact that gate depends on —
 * that author fields and Cancel stay inside the editor's own scroll owner,
 * while Save is available through the host-owned Action control.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mountedActions(): TriageMountedActionsV1 {
    return Object.freeze({
        read: TRIAGE_UNREAD_ACTIONS_V1,
        // A read has answered, so the editor's controls are live rather than
        // disabled behind an unread catalog.
        revision: 'revision-1',
        actions: Object.freeze([]),
        loaded: true,
        busy: false,
        notice: null,
        unavailableReason: null,
        retry() {},
        async resolveForExecution() { return { status: 'unavailable' as const }; },
        prepareAdminister(input) { return { input }; },
        async settleAdminister() { return null; },
        async administer() { return null; },
    });
}

const editorSurface = defineUiSurface(() => (
    <TriageActionsEditor actions={mountedActions()} />
));

const mounted: PluginUiTestkit[] = [];
const controls = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();

async function mountEditor(): Promise<PluginUiTestkit> {
    const host = createPluginUiActionControlTestHost(async () => ({ ok: true, result: { status: 'conflict' } }));
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-185', mountNonce: 'fixture-mount-185' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: editorSurface,
            surfaceContext: createSurfaceContextFixture({}),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                actionControl: host.handler,
                executeAction: async () => { throw new Error('No daemon is reachable from this mount.'); },
            },
        });
    });
    mounted.push(fixture);
    controls.set(fixture, host);
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

function editorScrollRegion(): HTMLElement | null {
    return document.querySelector<HTMLElement>(
        `[data-testid="${TRIAGE_ACTIONS_EDITOR_SCROLL_TEST_ID_V1}"]`,
    );
}

function controlNamed(title: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="button"]'))
        .find((control) => control.textContent?.includes(title));
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the configured-action editor inside the clipped work region', () => {
    it('owns one scrolling region for everything it asks a person to fill in', async () => {
        const editor = await mountEditor();

        await act(async () => {
            await editor.press(await editor.getByRole('button', { name: 'Add an action' }));
        });

        const region = editorScrollRegion();
        expect(region).not.toBeNull();

        // Coordination 2026-11-12: Save is owned by the host Action slot;
        // author fields and Cancel retain their existing scrolling region.
        expect(controls.get(editor)?.presentation('Save')).toBeDefined();
        expect(region?.contains(controlNamed('Cancel') ?? null)).toBe(true);
    });

    it('scrolls its own region rather than wrapping anything else in one', async () => {
        const editor = await mountEditor();
        await act(async () => {
            await editor.press(await editor.getByRole('button', { name: 'Add an action' }));
        });

        // Exactly one scroll owner belongs to this editor. A second one here
        // would be nested same-axis scrolling, which is the failure mode the
        // list's virtualizer cannot survive.
        expect(document.querySelectorAll(
            `[data-testid="${TRIAGE_ACTIONS_EDITOR_SCROLL_TEST_ID_V1}"]`,
        )).toHaveLength(1);
    });
});

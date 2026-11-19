// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

/**
 * An editor's inline header controls at large text in a narrow document column (FIN-QA-LARGETEXT F6:
 * Edit with an agent, ⋯ and Run now ran 21 px past the column and Run now was cut).
 */
it('wraps inline controls wider than the whole column within it instead of drawing past it', async () => {
    const { HappierPageHeader } = await import('@happier-dev/plugin-ui/presentation');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <View testID="column" style={{ width: 300 }}>
            <HappierPageHeader title="Review the release handoff before rollout" actionsLayout="inline" testID="header"
                actions={<>
                    <View testID="edit" style={{ width: 150, height: 32 }} />
                    <View testID="menu" style={{ width: 32, height: 32 }} />
                    <View testID="run" style={{ width: 110, height: 32 }} />
                </>} />
        </View>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 400, height: 600 }, settle: replay => act(replay) });
    const column = layout.rect('column');
    for (const id of ['edit', 'menu', 'run']) {
        expect(layout.rect(id).right).toBeLessThanOrEqual(column.right + 0.5);
    }
    // The primary still closes the controls on their trailing edge.
    expect(layout.rect('run').right).toBeGreaterThanOrEqual(layout.rect('edit').right - 0.5);
});

/**
 * A page whose content hangs beside a mark column (a workflow's steps on a phone) starts its header's words on
 * that content's edge; every other page keeps the page's text edge (WF-ACCEPT-1119B fix 4).
 */
it('starts the title and its purpose on the content edge only when the page asks for an inset', async () => {
    const { HappierPageHeader } = await import('@happier-dev/plugin-ui/presentation');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const header = (testID: string, inset?: number) => (
        <HappierPageHeader testID={testID} title={<View testID={`${testID}-title`} style={{ height: 28, width: 120 }} />}
            description={<View testID={`${testID}-purpose`} style={{ height: 18, width: 200 }} />}
            {...(inset === undefined ? {} : { contentInsetPx: inset })} />
    );
    await act(async () => root!.render(
        <View testID="column" style={{ width: 390 }}>
            {header('plain')}
            {header('inset', 34)}
        </View>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 390, height: 600 }, settle: replay => act(replay) });
    const column = layout.rect('column');
    // By default the words sit on the page's text edge...
    expect(layout.rect('plain-title').left - column.left).toBeCloseTo(18, 0);
    expect(layout.rect('plain-purpose').left - column.left).toBeCloseTo(18, 0);
    // ...and with an inset, on the content's edge, the trailing edge unchanged.
    expect(layout.rect('inset-title').left - column.left).toBeCloseTo(52, 0);
    expect(layout.rect('inset-purpose').left - column.left).toBeCloseTo(52, 0);
});

/**
 * An editor's header whose controls and status hang from the title's line: the purpose runs under both at the full
 * width, so a status that appears or changes never re-wraps it (WF-ACCEPT-1119B fix 3, lab 1116b/1116c).
 */
it('runs a hanging header\'s purpose under its controls, whatever the controls hold', async () => {
    const { HappierPageHeader } = await import('@happier-dev/plugin-ui/presentation');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const header = (testID: string, statusWidth: number) => (
        <HappierPageHeader testID={testID} actionsLayout="hang" title="Fix what broke"
            description={<View testID={`${testID}-purpose`} style={{ height: 18, alignSelf: 'stretch' }} />}
            actions={<>
                <View style={{ width: statusWidth, height: 16 }} />
                <View style={{ width: 150, height: 32 }} />
                <View style={{ width: 100, height: 32 }} />
            </>} />
    );
    await act(async () => root!.render(
        <View testID="column" style={{ width: 900 }}>
            {header('saved', 40)}
            {header('unsaved', 140)}
        </View>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 900, height: 600 }, settle: replay => act(replay) });
    const saved = layout.rect('saved-purpose');
    const unsaved = layout.rect('unsaved-purpose');
    // The purpose spans past the controls' start, to the header's edge...
    expect(saved.right).toBeGreaterThan(900 - 18 - 300);
    // ...and keeps the same width whether the status is short or long.
    expect(Math.abs(saved.width - unsaved.width)).toBeLessThanOrEqual(0.5);
});

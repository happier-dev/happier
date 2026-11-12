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

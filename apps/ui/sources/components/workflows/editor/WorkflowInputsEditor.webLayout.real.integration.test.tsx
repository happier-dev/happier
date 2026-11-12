// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

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
 * An optional input's default beside its label in a phone's Settings pane at large text
 * (FIN-QA-LARGETEXT F8: the field ran 29 px past a 195 px screen).
 */
it.each([150, 420])('keeps an optional input\'s default field inside the pane (%spx)', async (width) => {
    const { WorkflowInputsEditor } = await import('./WorkflowInputsEditor');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <View testID="pane" style={{ width }}>
            <WorkflowInputsEditor testIDPrefix="editor" onChange={() => {}}
                inputs={[{ name: 'summary', valueType: 'json', required: false, default: { summary: 'Release notes' } }]} />
        </View>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: Math.max(width, 400), height: 600 }, settle: replay => act(replay) });
    const pane = layout.rect('pane');
    const field = layout.rect('editor-input-0-default');
    expect(field.left).toBeGreaterThanOrEqual(pane.left - 0.5);
    expect(field.right).toBeLessThanOrEqual(pane.right + 0.5);
});

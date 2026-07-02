import * as React from 'react';
import { describe, expect, it } from 'vitest';

import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

type PreviewPaneModule = typeof import('./SessionLocalServicePreviewPane');

async function loadPreviewPaneModule(): Promise<PreviewPaneModule | null> {
    return import('./SessionLocalServicePreviewPane').catch(() => null);
}

function createPreviewRow(overrides: Partial<Readonly<{
    accessUrl: string | null;
    expiresAt: number | null;
    resource: LocalServicePreviewResourceV1;
}>> = {}) {
    const resource: LocalServicePreviewResourceV1 = {
        previewId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
        owner: { kind: 'session', id: 'session_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/', search: '' },
        display: {
            title: 'Dashboard',
            addressLabel: 'localhost:5173',
            folderLabel: 'web',
            iconToken: 'browser',
        },
        originMode: 'host',
        browserTarget: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        },
    };

    return {
        previewId: resource.previewId,
        resource,
        accessUrl: 'https://preview-1.preview.happier.test/',
        expiresAt: 2_000,
        diagnostics: [],
        ...overrides,
    };
}

describe('SessionLocalServicePreviewPane', () => {
    it('renders a validated preview access URL in the preview frame', async () => {
        const mod = await loadPreviewPaneModule();

        expect(mod?.SessionLocalServicePreviewPane).toBeTypeOf('function');
        if (!mod) return;

        const screen = await renderScreen(
            <mod.SessionLocalServicePreviewPane
                preview={createPreviewRow()}
                platform="web"
                nowMs={() => 1_000}
                testID="local-preview"
            />,
        );

        expect(screen.findByTestId('local-preview-frame')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Dashboard');
        expect(screen.getTextContent()).toContain('localhost:5173');
    });

    it('blocks loopback access URLs on native preview surfaces', async () => {
        const mod = await loadPreviewPaneModule();

        expect(mod?.SessionLocalServicePreviewPane).toBeTypeOf('function');
        if (!mod) return;

        const screen = await renderScreen(
            <mod.SessionLocalServicePreviewPane
                preview={createPreviewRow({ accessUrl: 'http://127.0.0.1:5173/' })}
                platform="ios"
                nowMs={() => 1_000}
                testID="local-preview"
            />,
        );

        expect(screen.findByTestId('local-preview-unavailable-native_loopback_not_allowed')).toBeTruthy();
    });

    it('does not render expired preview access URLs', async () => {
        const mod = await loadPreviewPaneModule();

        expect(mod?.SessionLocalServicePreviewPane).toBeTypeOf('function');
        if (!mod) return;

        const screen = await renderScreen(
            <mod.SessionLocalServicePreviewPane
                preview={createPreviewRow({ expiresAt: 900 })}
                platform="web"
                nowMs={() => 1_000}
                testID="local-preview"
            />,
        );

        expect(screen.findByTestId('local-preview-unavailable-expired')).toBeTruthy();
    });
});

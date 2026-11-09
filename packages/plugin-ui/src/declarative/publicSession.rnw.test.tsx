import { act, createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { buildPublicSessionDeclarativeView, mountPublicSessionDeclarative } from '../../../../apps/server/sources/app/api/routes/share/publicDeclarativeViewer.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginDeclarativeNodeV2Schema } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import { projectWidgetSnapshotPreviewV1, WidgetSnapshotDocumentV1Schema } from '@happier-dev/protocol/widgets';
import { publicSessionDeclarativeDocument as document } from './publicSession.fixture.testSupport.js';
import { createDeclarativeTextResolver } from './declarativeNodes.js';
import { projectHappierUiEnvironment } from '../environment/projectEnvironment.js';
import { buildArtifactHtmlDocumentV1 } from '@happier-dev/plugin-sdk/ui';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { externalTableVisual, externalChartVisual, externalHtmlVisual, externalHtmlBundle } from '../../fixtures/external-authoring/src/sessionVisuals.js';

describe('public Session portable declarative rendering', () => {
    it('substitutes scalar label data in frozen text and the current surface locale', () => {
        const title = { key: 'review.continue', fallback: 'Continue {count} more · {pullRequest}',
            params: { count: 7, pullRequest: 'example/repository#1' } };
        const root = PluginDeclarativeNodeV2Schema.parse({ kind: 'state', state: 'empty', title });
        const context = createSurfaceContext();
        const mounted = mountThroughReactNativeWeb(createElement('div', null,
            buildPublicSessionDeclarativeView({ version: 1, root }, context.theme)));
        try { expect(mounted.container.textContent).toContain('Continue 7 more · example/repository#1'); }
        finally { mounted.unmount(); }
        const environment = projectHappierUiEnvironment({ ...context,
            translations: { 'review.continue': '{pullRequest} : encore {count}' } });
        expect(createDeclarativeTextResolver(environment.localization.translate)(title))
            .toBe('example/repository#1 : encore 7');
    });
    it('admits and renders source-driven external author visuals through public bundle and Action contracts', () => {
        const schema = getActionSpec('session.board.item.upsert').inputSchema;
        expect(schema.safeParse(externalTableVisual).success).toBe(true);
        expect(schema.safeParse(externalHtmlVisual).success).toBe(true);
        const mounted = mountThroughReactNativeWeb(createElement('div', null,
            buildPublicSessionDeclarativeView(externalTableVisual.item.source.document, createSurfaceContext().theme)));
        try {
            expect(mounted.container.textContent).toContain('Copper');
            expect(mounted.container.textContent).toContain('0.000017');
            expect(mounted.container.querySelectorAll('button, [role="button"]')).toHaveLength(0);
        } finally { mounted.unmount(); }
        const html = buildArtifactHtmlDocumentV1(externalHtmlBundle);
        expect(html).toContain('External author visual');
        expect(html).toContain('Content-Security-Policy');
        expect(html).not.toContain('unsafe-eval');
    });
    it('renders the authored multi-series chart after snapshot projection while excluding undisplayed data', () => {
        const authored = getActionSpec('session.board.item.upsert').inputSchema.parse({ ...externalChartVisual,
            item: { ...externalChartVisual.item, source: { kind: 'declarative', document: {
                ...externalChartVisual.item.source.document,
                root: { ...externalChartVisual.item.source.document.root, data: { kind: 'value', value:
                    externalChartVisual.item.source.document.root.data.value.map(row => ({ ...row, privateNote: 'undisplayed-secret' })) } },
            } } },
        });
        if (authored.item.source.kind !== 'declarative') throw new Error('Expected the admitted chart document');
        const preview = projectWidgetSnapshotPreviewV1({ document: authored.item.source.document,
            frozenByPath: new Map(), asOf: '2026-10-12T00:00:00.000Z', provenance: [{ label: 'Rainfall measurements' }] });
        expect(preview).not.toBeNull();
        const document = WidgetSnapshotDocumentV1Schema.parse(preview!.document);
        expect(JSON.stringify(document)).not.toContain('undisplayed-secret');
        expect(JSON.stringify(document)).not.toContain('privateNote');
        const mounted = mountThroughReactNativeWeb(createElement('div', null,
            buildPublicSessionDeclarativeView(document, createSurfaceContext().theme)));
        try {
            const chart = mounted.container.querySelector('[data-testid="plugin-declarative-chart"]');
            expect(chart?.getAttribute('aria-label')).toContain('North 0.00004');
            expect(chart?.getAttribute('aria-label')).toContain('South 7');
            act(() => mounted.container.querySelector<HTMLButtonElement>('[data-testid="plugin-declarative-chart-values-toggle"]')!.click());
            const rows = [...mounted.container.querySelectorAll('[data-testid^="plugin-declarative-chart-values-row-"]')]
                .map(row => row.getAttribute('aria-label'));
            expect(rows).toHaveLength(2);
            expect(rows[0]).toEqual(expect.stringContaining('North: 0.00004'));
            expect(rows[0]).toEqual(expect.stringContaining('South: 7'));
            expect(rows[1]).toEqual(expect.stringContaining('North: —'));
            expect(rows[1]).toEqual(expect.stringContaining('South: 0'));
            expect(mounted.container.textContent).not.toContain('undisplayed-secret');
        } finally { mounted.unmount(); }
    });
    it('renders Markdown, exact table values and state semantics through the portable owner', () => {
        const mounted = mountThroughReactNativeWeb(createElement('div', null,
            buildPublicSessionDeclarativeView(document, createSurfaceContext().theme)));
        try {
            expect(mounted.container.textContent).toContain('**Experiment result**');
            expect(mounted.container.textContent).toContain('Copper');
            expect(mounted.container.textContent).toContain('0.000017');
            expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain('Source unavailable');
            expect(mounted.container.querySelectorAll('button, [role="button"]')).toHaveLength(0);
        } finally { mounted.unmount(); }
    });

    it('rejects a private Resource source at Session admission and disposes a mounted public body', async () => {
        const privateResource = PluginDeclarativeNodeV2Schema.parse({
            kind: 'metric', label: 'Private spend', value: { path: ['cost'], type: 'number' },
            data: { kind: 'resource', resource: { pluginId: 'com.acme.private', localId: 'spend' },
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object', properties: { cost: { type: 'number' } }, required: ['cost'], additionalProperties: false } },
        });
        expect(() => buildPublicSessionDeclarativeView({ version: 1, root: privateResource }, createSurfaceContext().theme)).toThrow();
        const root = globalThis.document.createElement('div');
        globalThis.document.body.append(root);
        let dispose: (() => void) | undefined;
        try {
            await act(async () => { dispose = mountPublicSessionDeclarative(root, document); });
            expect(root.textContent).toContain('Copper');
            act(() => dispose?.());
            dispose = undefined;
            expect(root.childElementCount).toBe(0);
        } finally { act(() => dispose?.()); root.remove(); }
    });
});

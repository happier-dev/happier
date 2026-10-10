import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board/item';
import { describe, expect, it } from 'vitest';

import { buildSessionBoardHostedHtmlItem, readSessionBoardHostedHtmlItemText } from './sessionBoardHostedHtmlItem';

describe('Session Board hosted HTML item content', () => {
    it('edits the existing bundle entrypoint while preserving every asset and MIME', () => {
        const body = artifactHtmlBundleFromBodyV1('<main>before</main>');
        const bundle = {
            ...body,
            entrypoint: 'pages/start.html',
            files: {
                'pages/start.html': { ...body.files[body.entrypoint], mime: 'TEXT/HTML' },
                'app.js': { mime: 'application/javascript', contentBase64: 'YWxlcnQoMSk=' },
                'style.css': { mime: 'text/css', contentBase64: 'Ym9keXt9' },
            },
        };
        const baseItem = SessionSurfaceItemV1Schema.parse({
            v: 1, destination: 'both', title: 'Dashboard', frame: 'full_bleed', height: { mode: 'fixed', size: 'tall' },
            source: { kind: 'hostedHtml', source: bundle },
        });
        const result = buildSessionBoardHostedHtmlItem({ title: 'Dashboard', html: '<main>after</main>', baseItem });
        expect(readSessionBoardHostedHtmlItemText(baseItem)).toBe('<main>before</main>');
        expect(result).toEqual({
            ...baseItem,
            source: {
                ...baseItem.source,
                source: {
                    ...bundle,
                    files: {
                        ...bundle.files,
                        'pages/start.html': {
                            ...bundle.files['pages/start.html'],
                            contentBase64: artifactHtmlBundleFromBodyV1('<main>after</main>').files['index.html'].contentBase64,
                        },
                    },
                },
            },
        });
    });

    it('builds the canonical capability-free hosted HTML item', () => {
        expect(buildSessionBoardHostedHtmlItem({ title: ' Dashboard ', html: '<main>Hello</main>' })).toEqual({
            v: 1,
            title: 'Dashboard',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>Hello</main>') },
        });
    });

    it('round-trips Unicode HTML beyond the retired string ceiling', () => {
        const html = '<main>' + 'é☀️'.repeat(262145) + '</main>';
        const item = buildSessionBoardHostedHtmlItem({ title: 'Large visual', html });
        expect(item).not.toBeNull();
        expect(readSessionBoardHostedHtmlItemText(item!)).toBe(html);
    });

    it('keeps unreadable entrypoint bytes unavailable instead of silently changing them', () => {
        const item = SessionSurfaceItemV1Schema.parse({
            v: 1, title: 'Unreadable', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: {
                kind: 'hostedHtml',
                source: { v: 1, entrypoint: 'index.html', files: {
                    'index.html': { mime: 'text/html', contentBase64: '/w==' },
                } },
            },
        });
        expect(readSessionBoardHostedHtmlItemText(item)).toBeNull();
    });
});

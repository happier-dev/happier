import * as React from 'react';
import { Platform } from 'react-native';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { ArtifactHtmlPreview } from '@/sync/domains/artifacts/artifactTypes';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactHtmlBody } from './ArtifactHtmlBody';

const platform = Platform.OS;
afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function setPlatform(value: 'web' | 'android') {
    Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

const previewUrl = 'https://artifact-1.preview.example.test/a/artifact-1';
const preview = { url: previewUrl, bundle: artifactHtmlBundleFromBodyV1('<h1>Report</h1>') };
const props = { artifactId: 'artifact-1', headerVersion: 1, bodyVersion: 1, body: '<h1>Report</h1>', name: 'Report' };

describe('ArtifactHtmlBody', () => {
    it('loads private opened bytes in the shared opaque bundle frame without a data URL or host bridge', async () => {
        setPlatform('web');
        vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => preview} />);
        await flushHookEffects();
        const frame = screen.tree.root.findByType('iframe');
        expect(frame.props).toMatchObject({ sandbox: 'allow-scripts',
            referrerPolicy: 'no-referrer', title: 'Report' });
        expect(frame.props.src).toBeUndefined();
        expect(frame.props.srcDoc).toContain('<h1>Report</h1>');
        expect(frame.props.onMessage).toBeUndefined();
        await act(async () => { frame.props.onError(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        await flushHookEffects();
        expect(screen.tree.root.findByType('iframe').props.srcDoc).toContain('<h1>Report</h1>');
    });

    it('refuses app-origin, inline, and credential-bearing preview URLs visibly', async () => {
        setPlatform('web');
        vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
        for (const url of ['https://app.example.test/a/artifact-1#d=bundle', 'data:text/html,<script>alert(1)</script>',
            'blob:https://app.example.test/html', 'https://user:secret@preview.example.test/a/artifact-1']) {
            const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => ({ ...preview, url })} />);
            await flushHookEffects();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
            await screen.unmount();
        }
    });

    it('cancels obsolete previews when content, version or selection changes and ignores late results', async () => {
        setPlatform('web');
        const pending = createDeferred<ArtifactHtmlPreview>();
        const signals: AbortSignal[] = [];
        let nextUrl = pending.promise;
        const readPreview = async (_id: string, signal?: AbortSignal) => {
            signals.push(signal!);
            return nextUrl;
        };
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={readPreview} />);
        nextUrl = Promise.resolve(preview);
        await screen.update(<ArtifactHtmlBody {...props} body="<h1>New report</h1>" readPreview={readPreview} />);
        await flushHookEffects();
        expect(signals[0]!.aborted).toBe(true);
        pending.resolve({ ...preview, url: 'https://old.preview.example.test/a/artifact-1' });
        await flushHookEffects();
        expect(screen.tree.root.findByType('iframe').props.srcDoc).toContain('<h1>Report</h1>');
        const revision = createDeferred<ArtifactHtmlPreview>();
        nextUrl = revision.promise;
        await screen.update(<ArtifactHtmlBody {...props} bodyVersion={2} readPreview={readPreview} />);
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        expect(signals[1]!.aborted).toBe(true);
        nextUrl = Promise.resolve({ url: 'https://artifact-2.preview.example.test/a/artifact-2', bundle: artifactHtmlBundleFromBodyV1('<h1>Second</h1>') });
        await screen.update(<ArtifactHtmlBody {...props} artifactId="artifact-2" readPreview={readPreview} />);
        revision.reject(new Error('Obsolete read failed'));
        await flushHookEffects();
        expect(signals[2]!.aborted).toBe(true);
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).toBeNull();
        expect(screen.tree.root.findByType('iframe').props.srcDoc).toContain('<h1>Second</h1>');
        await screen.unmount();
        expect(signals[3]!.aborted).toBe(true);
    });

    it('preserves valid expanded private content beyond the HTML-string transport boundary', async () => {
        setPlatform('web');
        const html = `<main>${'valid'.repeat(420_000)}</main>`;
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => ({
            url: previewUrl, bundle: artifactHtmlBundleFromBodyV1(html),
        })} />);
        await flushHookEffects();
        const frame = screen.tree.root.findByType('iframe');
        expect(frame.props.srcDoc).toContain(html);
        expect(new TextEncoder().encode(frame.props.srcDoc).byteLength).toBeGreaterThan(2 * 1024 * 1024);
        expect(frame.props.src).toBeUndefined();
    });

    it('ignores a delayed frame failure after another artifact has opened', async () => {
        setPlatform('web');
        const readPreview = async (id: string) => ({ url: `https://${id}.preview.example.test/a/${id}`, bundle: artifactHtmlBundleFromBodyV1(`<h1>${id}</h1>`) });
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={readPreview} />);
        await flushHookEffects();
        const oldFrameFailure = screen.tree.root.findByType('iframe').props.onError;
        await screen.update(<ArtifactHtmlBody {...props} artifactId="artifact-2" readPreview={readPreview} />);
        await flushHookEffects();
        await act(async () => { oldFrameFailure(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).toBeNull();
        expect(screen.tree.root.findByType('iframe').props.srcDoc).toContain('<h1>artifact-2</h1>');
    });
});

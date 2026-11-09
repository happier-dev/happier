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

// react-test-renderer has no DOM portal container; keep the real shell and guest
// logic while representing only ReactDOM's cross-document mount boundary.
vi.mock('react-dom', async importOriginal => ({
    ...await importOriginal<typeof import('react-dom')>(),
    createPortal: (children: React.ReactNode) => children,
}));

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

const preview = { bundle: artifactHtmlBundleFromBodyV1('<h1>Report</h1>') };
const props = { artifactId: 'artifact-1', headerVersion: 1, bodyVersion: 1, body: '<h1>Report</h1>', name: 'Report' };

async function loadPreviewGuest(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await flushHookEffects();
    const shell = screen.findHostByTestId('artifact:htmlPreview-navigation-shell');
    if (!shell) throw new Error('Artifact navigation shell did not mount');
    await act(async () => { shell.props.onLoad({ currentTarget: { contentDocument: { body: {} } } }); });
    const guest = screen.findHostByTestId('artifact:htmlPreview');
    if (!guest) throw new Error('Artifact guest did not mount');
    return guest;
}

describe('ArtifactHtmlBody', () => {
    it('uses the saved Artifact network policy rather than a viewer preference or implicit open default', async () => {
        setPlatform('web');
        const policies = [
            { requestedCapabilities: { network: 'open' as const }, connect: 'data: https:' },
            { requestedCapabilities: { network: 'none' as const }, connect: 'data:' },
            { requestedCapabilities: { networkOrigins: ['https://api.example.test'] }, connect: 'data: https://api.example.test' },
        ];
        for (const { requestedCapabilities, connect } of policies) {
            const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => ({ ...preview,
                bundle: { ...preview.bundle, requestedCapabilities },
            })} />);
            const frame = await loadPreviewGuest(screen);
            expect(screen.findHostByTestId('artifact:htmlPreview-navigation-shell')!.props.srcDoc).toContain("connect-src 'self'");
            expect(frame.props.srcDoc).toContain(`connect-src ${connect};`);
            expect(frame.props.srcDoc).not.toContain("connect-src 'self'");
            await screen.unmount();
        }
    });
    it('loads private opened bytes in the shared opaque bundle frame without a data URL or host bridge', async () => {
        setPlatform('web');
        vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => preview} />);
        const frame = await loadPreviewGuest(screen);
        expect(frame.props).toMatchObject({ sandbox: 'allow-scripts',
            referrerPolicy: 'no-referrer', title: 'Report' });
        expect(frame.props.src).toBeUndefined();
        expect(frame.props.srcDoc).toContain('<h1>Report</h1>');
        expect(frame.props.onMessage).toBeUndefined();
        await act(async () => { frame.props.onError(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        expect((await loadPreviewGuest(screen)).props.srcDoc).toContain('<h1>Report</h1>');
    });

    it('shows a failed private read without mounting a guest', async () => {
        setPlatform('web');
        vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => { throw new Error('Private read unavailable'); }} />);
        await flushHookEffects();
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
        await screen.unmount();
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
        await loadPreviewGuest(screen);
        expect(signals[0]!.aborted).toBe(true);
        pending.resolve(preview);
        await flushHookEffects();
        expect(screen.findHostByTestId('artifact:htmlPreview')!.props.srcDoc).toContain('<h1>Report</h1>');
        const revision = createDeferred<ArtifactHtmlPreview>();
        nextUrl = revision.promise;
        await screen.update(<ArtifactHtmlBody {...props} bodyVersion={2} readPreview={readPreview} />);
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        expect(signals[1]!.aborted).toBe(true);
        nextUrl = Promise.resolve({ bundle: artifactHtmlBundleFromBodyV1('<h1>Second</h1>') });
        await screen.update(<ArtifactHtmlBody {...props} artifactId="artifact-2" readPreview={readPreview} />);
        revision.reject(new Error('Obsolete read failed'));
        const secondFrame = await loadPreviewGuest(screen);
        expect(signals[2]!.aborted).toBe(true);
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).toBeNull();
        expect(secondFrame.props.srcDoc).toContain('<h1>Second</h1>');
        await screen.unmount();
        expect(signals[3]!.aborted).toBe(true);
    });

    it('preserves valid expanded private content beyond the HTML-string transport boundary', async () => {
        setPlatform('web');
        const html = `<main>${'valid'.repeat(420_000)}</main>`;
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={async () => ({
            bundle: artifactHtmlBundleFromBodyV1(html),
        })} />);
        const frame = await loadPreviewGuest(screen);
        expect(frame.props.srcDoc).toContain(html);
        expect(new TextEncoder().encode(frame.props.srcDoc).byteLength).toBeGreaterThan(2 * 1024 * 1024);
        expect(frame.props.src).toBeUndefined();
    });

    it('ignores a delayed frame failure after another artifact has opened', async () => {
        setPlatform('web');
        const readPreview = async (id: string) => ({ bundle: artifactHtmlBundleFromBodyV1(`<h1>${id}</h1>`) });
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreview={readPreview} />);
        const oldFrameFailure = (await loadPreviewGuest(screen)).props.onError;
        await screen.update(<ArtifactHtmlBody {...props} artifactId="artifact-2" readPreview={readPreview} />);
        const nextFrame = await loadPreviewGuest(screen);
        await act(async () => { oldFrameFailure(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).toBeNull();
        expect(nextFrame.props.srcDoc).toContain('<h1>artifact-2</h1>');
    });
});

import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/src/WebViewShared';
import type { ShouldStartLoadRequestEvent } from 'react-native-webview/lib/WebViewTypes';
import { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});
// The native SDK is the rendering boundary; the real preview lifecycle remains under test.
vi.mock('react-native-webview', () => ({
    WebView: (props: Readonly<Record<string, unknown>>) => React.createElement('WebView', props),
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

const previewUrl = 'https://artifact-1.preview.example.test/a/artifact-1#d=bundle';
const props = { artifactId: 'artifact-1', headerVersion: 1, bodyVersion: 1, body: '<h1>Report</h1>', name: 'Report' };

describe('ArtifactHtmlBody', () => {
    it('loads only the isolated viewer URL in a credentialless sandbox without a host bridge', async () => {
        setPlatform('web');
        vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreviewUrl={async () => previewUrl} />);
        await flushHookEffects();
        const frame = screen.tree.root.findByType('iframe');
        expect(frame.props).toMatchObject({ src: previewUrl, sandbox: 'allow-scripts allow-same-origin',
            referrerPolicy: 'no-referrer', title: 'Report' });
        expect(renderToStaticMarkup(React.createElement('iframe', frame.props))).toContain('credentialless=""');
        expect(frame.props.srcDoc).toBeUndefined();
        expect(frame.props.onMessage).toBeUndefined();
        await act(async () => { frame.props.onError(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        await flushHookEffects();
        expect(screen.tree.root.findByType('iframe').props.src).toBe(previewUrl);
    });

    it('refuses app-origin, inline, and credential-bearing preview URLs visibly', async () => {
        setPlatform('web');
        vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
        for (const url of ['https://app.example.test/a/artifact-1#d=bundle', 'data:text/html,<script>alert(1)</script>',
            'blob:https://app.example.test/html', 'https://user:secret@preview.example.test/a/artifact-1']) {
            const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreviewUrl={async () => url} />);
            await flushHookEffects();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
            await screen.unmount();
        }
    });

    it('cancels obsolete previews when content, version or selection changes and ignores late results', async () => {
        setPlatform('web');
        const pending = createDeferred<string>();
        const signals: AbortSignal[] = [];
        let nextUrl = pending.promise;
        const readPreviewUrl = async (_id: string, signal?: AbortSignal) => {
            signals.push(signal!);
            return nextUrl;
        };
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreviewUrl={readPreviewUrl} />);
        nextUrl = Promise.resolve(previewUrl);
        await screen.update(<ArtifactHtmlBody {...props} body="<h1>New report</h1>" readPreviewUrl={readPreviewUrl} />);
        await flushHookEffects();
        expect(signals[0]!.aborted).toBe(true);
        pending.resolve('https://old.preview.example.test/a/artifact-1#d=old');
        await flushHookEffects();
        expect(screen.tree.root.findByType('iframe').props.src).toBe(previewUrl);
        const revision = createDeferred<string>();
        nextUrl = revision.promise;
        await screen.update(<ArtifactHtmlBody {...props} bodyVersion={2} readPreviewUrl={readPreviewUrl} />);
        expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
        expect(signals[1]!.aborted).toBe(true);
        nextUrl = Promise.resolve('https://artifact-2.preview.example.test/a/artifact-2#d=new');
        await screen.update(<ArtifactHtmlBody {...props} artifactId="artifact-2" readPreviewUrl={readPreviewUrl} />);
        revision.reject(new Error('Obsolete read failed'));
        await flushHookEffects();
        expect(signals[2]!.aborted).toBe(true);
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).toBeNull();
        expect(screen.tree.root.findByType('iframe').props.src).toContain('/a/artifact-2');
        await screen.unmount();
        expect(signals[3]!.aborted).toBe(true);
    });

    it('keeps native rendering private and denies navigation away from the exact isolated origin', async () => {
        setPlatform('android');
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreviewUrl={async () => previewUrl} />);
        await flushHookEffects();
        const frame = screen.tree.root.findByType('WebView');
        expect(frame.props).toMatchObject({ source: { uri: previewUrl }, incognito: true, sharedCookiesEnabled: false,
            thirdPartyCookiesEnabled: false, mixedContentMode: 'never', javaScriptEnabled: true,
            javaScriptCanOpenWindowsAutomatically: false, allowFileAccess: false,
            allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false });
        expect(frame.props.onMessage).toBeUndefined();
        expect(frame.props.injectedJavaScript).toBeUndefined();
        expect(frame.props.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
        const navigate = frame.props.onShouldStartLoadWithRequest;
        expect(navigate({ url: previewUrl, isTopFrame: true })).toBe(true);
        expect(navigate({ url: 'https://artifact-1.preview.example.test/other', isTopFrame: true })).toBe(true);
        expect(navigate({ url: 'https://artifact-2.preview.example.test/a/artifact-2', isTopFrame: true })).toBe(false);
        expect(navigate({ url: 'https://app.example.test/api', isTopFrame: true })).toBe(false);
        expect(navigate({ url: 'file:///secret', isTopFrame: true })).toBe(false);
        vi.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
        const openExternal = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        const decisions: boolean[] = [];
        const sdkNavigate = createOnShouldStartLoadWithRequest(allowed => decisions.push(allowed),
            frame.props.originWhitelist, navigate);
        // Only the native event carrier is substituted; the installed SDK's dispatch runs unchanged.
        sdkNavigate({ nativeEvent: { url: 'https://escape.example.test', isTopFrame: true, lockIdentifier: 1 } } as ShouldStartLoadRequestEvent);
        await flushHookEffects();
        expect(decisions).toEqual([false]);
        expect(openExternal).not.toHaveBeenCalled();
        await act(async () => { frame.props.onHttpError(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).not.toBeNull();
    });

    it('ignores a delayed frame failure after another artifact has opened', async () => {
        setPlatform('web');
        const readPreviewUrl = async (id: string) => `https://${id}.preview.example.test/a/${id}#d=bundle`;
        const screen = await renderScreen(<ArtifactHtmlBody {...props} readPreviewUrl={readPreviewUrl} />);
        await flushHookEffects();
        const oldFrameFailure = screen.tree.root.findByType('iframe').props.onError;
        await screen.update(<ArtifactHtmlBody {...props} artifactId="artifact-2" readPreviewUrl={readPreviewUrl} />);
        await flushHookEffects();
        await act(async () => { oldFrameFailure(); });
        expect(screen.findByTestId('artifact:htmlPreviewFailed')).toBeNull();
        expect(screen.tree.root.findByType('iframe').props.src).toContain('/a/artifact-2');
    });
});

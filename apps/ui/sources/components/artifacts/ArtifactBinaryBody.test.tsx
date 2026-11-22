import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { act, createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { Modal, ModalProvider } from '@/modal';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent, openArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { fetchArtifactBlob } from '@/sync/api/artifacts/apiArtifacts';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createArtifactActionsClient, type ArtifactActionsClient } from './artifactActionsClient';

const nativeBoundary = vi.hoisted(() => ({
    filesystem: null as ReturnType<typeof import('@/dev/testkit/mocks/expoFileSystem').createExpoFileSystemFileMock> | null,
    share: async (_uri: string, _name?: string, _mime?: string | null) => {},
}));
// iOS shares through the RN system Share sheet; this is the recipient boundary.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const Share = {
        sharedAction: 'sharedAction', dismissedAction: 'dismissedAction',
        share: async (content: { url: string }) => { await nativeBoundary.share(content.url); return { action: 'sharedAction' }; },
    };
    return { ...await createReactNativeWebMock(), Share };
});
vi.mock('expo-file-system', async () => {
    nativeBoundary.filesystem = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    return nativeBoundary.filesystem.module;
});
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true,
    shareAsync: async (uri: string) => nativeBoundary.share(uri) }));
vi.mock('expo-modules-core', async importOriginal => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions'
        ? { shareFile: (uri: string, fileName: string, mimeType?: string | null) => nativeBoundary.share(uri, fileName, mimeType) }
        : null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactBinaryBody, useArtifactBinaryActions } from './ArtifactBinaryBody';

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
let account: LazyActionAccountContext;
let accountSettings: ReturnType<typeof import('@/dev/testkit/harness/actionHomesHttpHarness').createAccountSettingsHttpBoundary>;
const blobRequests = new Map<string, () => Promise<Response>>();

beforeEach(async () => {
    await import('expo-file-system');
    nativeBoundary.filesystem!.files.clear();
    const { storage } = await import('@/sync/domains/state/storage');
    const settings = { filesImagePreviewCacheMaxEntries: 0, filesImagePreviewMaxBytes: 1_000_000 };
    storage.getState().applySettingsLocal(settings);
    blobRequests.clear();
    const serverUrl = 'https://binary-body.test';
    const { createAccountSettingsHttpBoundary } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    accountSettings = createAccountSettingsHttpBoundary({ serverUrl, initialAccounts: [{ accountId: 'artifact-account',
        snapshot: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: settings }, version: 1 }) }] });
    home = await createPlainArtifactHomeFixture(serverUrl, { currentAccount: true, accountSettingsVersion: 1,
        handleRequest: async (path, init) => {
            const settingsResponse = accountSettings.handle(new URL(path, serverUrl), init);
            if (settingsResponse) return settingsResponse;
            const match = /^\/v1\/artifacts\/([^/]+)\/blobs\//.exec(path);
            return match ? await blobRequests.get(decodeURIComponent(match[1]!))?.() ?? null : null;
        } });
    account = await captureLazyActionAccountContext(home.home.id);
});

afterEach(async () => { Modal.hideAll(); account?.dispose(); await home?.dispose(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function binarySource(artifactId: string, mime: string, bytes = new Uint8Array([0, 255, 128])) {
    const reference: ArtifactBlobReferenceV1 = { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62', mime,
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    // Only captured HTTP is substituted; the actual API mode/schema and binary opening owners run.
    const request = vi.fn(async () => new Response(JSON.stringify({ blobId: reference.blobId,
        content: { t: 'plain', v: encodeBase64(bytes) } })));
    const readBytes = async (artifactId: string, ref: ArtifactBlobReferenceV1, signal?: AbortSignal) => {
        const stored = await fetchArtifactBlob({ token: 'token' }, artifactId, ref.blobId, 'plain', { request, signal });
        return openArtifactBinaryContent({ reference: ref, content: stored.content, mode: 'plain', encryption: null });
    };
    blobRequests.set(artifactId, () => request());
    home.boundary.replaceStoredRow({ id: artifactId, ownerAccountId: account.accountId, access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ title: 'File' }), headerVersion: 1,
        body: encodePlainArtifactStoredContent({ body: reference }), bodyVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 1, createdAt: 1, updatedAt: 1 });
    let exportEnabled = true;
    const actions = createArtifactActionsClient({ serverId: home.home.id, accountId: account.accountId },
        createFrontDoorActionExecute(undefined, { isActionEnabled: id => id !== 'artifact.export' || exportEnabled }));
    return { reference, bytes, request, readBytes, actions, setExportEnabled: (enabled: boolean) => { exportEnabled = enabled; } };
}

function installDownloadDocument() {
    const anchor = { href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() };
    const styles = new Map<string, { id: string; textContent: string }>();
    // This is the browser DOM boundary: downloads and the real spinner's stylesheet
    // insertion share one document, just as they do in the browser.
    vi.stubGlobal('document', {
        getElementById: (id: string) => styles.get(id) ?? null,
        createElement: (tag: string) => tag === 'a' ? anchor : { id: '', textContent: '' },
        head: { appendChild: (style: { id: string; textContent: string }) => styles.set(style.id, style) },
        body: { appendChild: () => {} },
    });
    return anchor;
}

describe('ArtifactBinaryBody', () => {
    it('presents the authenticated binary read cause without replacing it with a renderer failure', async () => {
        const source = binarySource('denied-preview', 'application/pdf');
        source.request.mockImplementation(async () => Response.json({ error: 'artifact_access_forbidden' }, { status: 403 }));
        const screen = await renderScreen(<ArtifactBinaryBody artifactId="denied-preview" name="Report.pdf" {...source} />);
        await vi.waitFor(() => expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('errors.permissionDenied');
        expect(screen.findByTestId('artifact:viewerBody')).toBeNull();
        await screen.unmount();
    });

    it('says a version whose document is gone was not found, without a Retry that cannot work', async () => {
        const source = binarySource('deleted-version', 'application/pdf');
        // The Home's typed 404 body for a deleted Artifact (artifactsRoutes).
        source.request.mockImplementation(async () => Response.json({ error: 'Artifact not found' }, { status: 404 }));
        const screen = await renderScreen(<ArtifactBinaryBody artifactId="deleted-version" name="Report.pdf" {...source} />);
        await vi.waitFor(() => expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull());
        const text = screen.getTextContent();
        expect(text).toContain('artifacts.notFound');
        expect(text).not.toContain('artifacts.browser.loadFailedBody');
        expect(text).not.toContain('common.retry');
        await screen.unmount();
    });

    it('keeps Retry for a read that can succeed on another attempt', async () => {
        const source = binarySource('busy-version', 'application/pdf');
        source.request.mockImplementation(async () => new Response('busy', { status: 502 }));
        const screen = await renderScreen(<ArtifactBinaryBody artifactId="busy-version" name="Report.pdf" {...source} />);
        await vi.waitFor(() => expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('common.retry');
        await screen.unmount();
    });
    it('keeps PDF type and size visible and adds the page count reported by the viewer without another read', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const source = binarySource('pdf-facts', 'application/pdf', new TextEncoder().encode('%PDF-1.7'));
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<ArtifactBinaryBody artifactId="pdf-facts" name="Report.pdf" {...source} />);
            await waitForHomeGovernance(() => expect(screen!.tree.root.findAllByType('WebView')).toHaveLength(1));
            const text = () => JSON.stringify(screen!.findByTestId('artifact:binaryFacts')?.props.children) ?? '';
            expect(text()).toContain('files.kind.pdf');
            expect(text()).toContain('8 B');
            expect(text()).not.toContain('files.viewer.pdfPageCount');
            await act(async () => {
                screen!.tree.root.findByType('WebView').props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'ready', pages: 3 }) } });
            });
            await vi.waitFor(() => expect(text()).toContain('files.viewer.pdfPageCount'));
            expect(text()).toContain('3');
            expect(text()).toContain('files.kind.pdf');
            expect(source.request).toHaveBeenCalledOnce();
        } finally {
            await screen?.unmount();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });
    it('opens a PDF in the shared full-screen stage with the already acquired bytes', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('pdf-stage', 'application/pdf');
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-stage');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="pdf-stage" name="proof.pdf" {...source} />);
            await vi.waitFor(() => expect(screen.findByTestId('artifact:fullScreen')).not.toBeNull());
            vi.mocked(Modal.show).mockClear();
            await screen.pressByTestIdAsync('artifact:fullScreen');
            const [config] = vi.mocked(Modal.show).mock.calls[0] ?? [];
            expect(config).toMatchObject({ props: { initialIndex: 0, items: [{
                kind: 'pdf', title: 'proof.pdf', source: {
                    source: { kind: 'bytes', bytes: source.bytes },
                    cacheScopeId: 'pdf-stage', mimeType: 'application/pdf',
                },
            }] } });
            expect(source.request).toHaveBeenCalledOnce();
            await screen.unmount();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
    it('keeps export bytes private until native Ask is approved and downloads once', async () => {
        accountSettings.replaceAccountSettings(account.accountId, AccountSettingsV2GetResponseSchema.parse({
            content: { t: 'plain', v: { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { 'artifact.export': { approvalRequiredSurfaces: ['ui'] } } }) } }, version: 1,
        }));
        await home.hydrateAccountSettings();
        const source = binarySource('approved-export', 'application/zip');
        const anchor = installDownloadDocument();
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:approved-export');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        const hook = await renderHook(() => useArtifactBinaryActions());
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        let pending: ReturnType<ArtifactActionsClient['exportArtifact']> | undefined;
        act(() => {
            pending = hook.getCurrent().actions?.exportArtifact({ artifactId: 'approved-export', destination: 'client',
                reference: source.reference, fileName: 'approved.zip' });
        });
        const review = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        await waitForHomeGovernance(() => expect(review.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(hook.getCurrent().approval.approvalId).toBeNull();
        expect(anchor.click).not.toHaveBeenCalled();
        expect(source.request).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        await review.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        await expect(pending).resolves.toMatchObject({ ok: true, value: { status: 'saved', fileName: 'approved.zip' } });
        expect(anchor.click).toHaveBeenCalledOnce();
        await hook.rerender();
        expect(anchor.click).toHaveBeenCalledOnce();
        expect(router.push).not.toHaveBeenCalled();
        await review.unmount();
        await hook.unmount();
    });
    it('does not retarget a captured export from another Account to the active Account', async () => {
        const source = binarySource('other-account-export', 'application/zip');
        const hook = await renderHook(() => useArtifactBinaryActions(undefined,
            { serverId: home.home.id, accountId: 'other-account' }));
        const result = await hook.getCurrent().actions?.exportArtifact({ artifactId: 'other-account-export',
            destination: 'client', reference: source.reference, fileName: 'other.zip' });
        expect(result).toMatchObject({ ok: false, failure: { code: 'action_account_scope_changed' } });
        expect(source.request).not.toHaveBeenCalled();
        expect(hook.getCurrent().approval.approvalId).toBeNull();
        expect(home.boundary.list()).toHaveLength(1);
        await hook.unmount();
    });
    it('uses Action admission for Download and allows retry after export is enabled', async () => {
        const source = binarySource('html', 'text/html');
        source.setExportEnabled(false);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = installDownloadDocument();
        const screen = await renderScreen(<ArtifactBinaryBody artifactId="html" name="page.html" {...source} />);
        await screen.pressByTestIdAsync('artifact:download');
        await flushHookEffects();
        expect(anchor.click).not.toHaveBeenCalled();
        expect(source.request).not.toHaveBeenCalled();
        expect(screen.findByTestId('artifact:downloadFailed')).not.toBeNull();
        const details = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.text === 'approvals.technicalDetails');
        expect(details).toBeDefined();
        await act(async () => { details?.onPress?.(); });
        expect(Modal.alert).toHaveBeenLastCalledWith('approvals.technicalDetails', 'action_disabled');
        source.setExportEnabled(true);
        await screen.pressByTestIdAsync('artifact:download');
        await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce());
        expect(screen.findByTestId('artifact:downloadFailed')).toBeNull();
    });
    it.each(['image/svg+xml', 'application/pdf'])('materializes %s through the shared bytes owner', async mime => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource(mime, mime);
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected preview Blob');
            blobs.push(blob);
            return 'blob:artifact-preview';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId={mime} name="preview" {...source} />);
            await vi.waitFor(() => expect(blobs).toHaveLength(1));
            expect(blobs[0]!.type).toBe(mime);
            expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(source.bytes);
            await screen.unmount();
            expect(revoke).toHaveBeenCalledWith('blob:artifact-preview');
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
    it('applies the shared web buffering budget before creating an Artifact preview URI', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES', '2');
        const source = binarySource('svg-budget', 'image/svg+xml');
        const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="svg-budget" name="icon.svg" {...source} />);
            await flushHookEffects();
            expect(createUrl).not.toHaveBeenCalled();
            expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull();
            expect(JSON.stringify(screen.tree.toJSON())).toContain('files.imagePreviewTooLarge');
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
    it.each([
        ['android', 'success'], ['android', 'failure'], ['ios', 'success'], ['ios', 'failure'],
    ] as const)('preserves PDF download custody through %s sharing %s', async (platform, outcome) => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        // This case changes the OS after the Home fixture was captured on web;
        // populate the native device credential boundary through its real owner.
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const nativeCredential = await TokenStorage.setCredentialsForServerUrlWithRollback(
            home.home.serverUrl, { serverId: home.home.id }, account.credentials);
        expect(nativeCredential).not.toBeNull();
        const source = binarySource('pdf', 'application/pdf');
        const filesystem = nativeBoundary.filesystem!;
        const files = filesystem.files;
        const androidShares: string[] = [];
        const iosShares: string[] = [];
        // Only Expo filesystem/native SDK boundaries are substituted; artifact HTTP/schema,
        // content validation, cache lifetime and the sharing adapters remain real.
        nativeBoundary.share = async (uri, name, mimeType) => {
            if (platform === 'ios') {
                iosShares.push(uri);
                expect(files.get(uri)).toEqual([...source.bytes]);
                if (outcome === 'failure') throw new Error('Share sheet failed');
            } else {
                androidShares.push(uri);
                expect(name).toBe('Quarterly report');
                expect(mimeType).toBe('application/pdf');
                expect(files.get(uri)).toEqual([...source.bytes]);
                if (outcome === 'failure') throw new Error('Share chooser failed');
            }
        };
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="pdf" name="Quarterly report" {...source} />);
            await flushHookEffects();
            expect(source.request).toHaveBeenCalledOnce();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            await screen.pressByTestIdAsync('artifact:download');
            await waitForHomeGovernance(() => {
                expect(androidShares.length + iosShares.length).toBe(1);
                expect(screen.findByTestId('artifact:downloadFailed') !== null).toBe(outcome === 'failure');
                if (platform !== 'android' || outcome === 'failure') {
                    expect([...files.keys()].filter(uri => uri.includes('/happier-downloads/'))).toEqual([]);
                }
            });
            const shared = platform === 'android' ? androidShares : iosShares;
            if (platform === 'android' && outcome === 'success') expect([...files.entries()].filter(([uri]) => uri.includes('/happier-downloads/')).map(([, bytes]) => bytes)).toEqual([[...source.bytes]]);
            expect(shared).toHaveLength(1);
            if (platform === 'android') expect(decodeURI(shared[0]!)).toMatch(/^file:\/\/\/cache\/happier-downloads\/.*Quarterly report$/);
            if (platform === 'android') expect(iosShares).toEqual([]);
            else expect(androidShares).toEqual([]);
            if (platform === 'android' && outcome === 'success') expect(files.get(shared[0]!)).toEqual([...source.bytes]);
            else expect([...files.keys()].filter(uri => uri.includes('/happier-downloads/'))).toEqual([]);
            expect(screen.findByTestId('artifact:downloadFailed') !== null).toBe(outcome === 'failure');
            await screen.unmount();
        } finally {
            await nativeCredential?.rollback();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });

    it('cancels an old selection download and leaves the next file actionable', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const first = binarySource('first', 'application/zip');
        const pending = createDeferred<Response>();
        first.request.mockImplementation(() => pending.promise);
        const next = binarySource('next', 'text/html');
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:next');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = installDownloadDocument();
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="first" name="first.zip" {...first} />);
            await screen.pressByTestIdAsync('artifact:download');
            await screen.update(<ArtifactBinaryBody artifactId="next" name="next.html" {...next} />);
            await screen.pressByTestIdAsync('artifact:download');
            await waitForHomeGovernance(() => expect(anchor.click).toHaveBeenCalledOnce());
            expect(anchor.download).toBe('next.html');
            expect(anchor.click).toHaveBeenCalledOnce();
            pending.resolve(new Response(JSON.stringify({ blobId: first.reference.blobId, content: { t: 'plain', v: encodeBase64(first.bytes) } })));
            await flushHookEffects();
            expect(anchor.download).toBe('next.html');
            expect(anchor.click).toHaveBeenCalledOnce();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('shows private image bytes and releases the temporary preview on unmount', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('image', 'image/png');
        const urls: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected binary preview Blob');
            urls.push(blob); return 'blob:private-image';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="image" name="image.png" {...source} />);
            await flushHookEffects();
            expect(screen.findByTestId('artifact:viewerBody-picture')).not.toBeNull();
            expect(new Uint8Array(await urls[0]!.arrayBuffer())).toEqual(source.bytes);
            // The modal presentation is the boundary; the press opens the one Media stage.
            await screen.pressByTestIdAsync('artifact:viewerBody-open');
            await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
            await screen.unmount();
            await flushHookEffects();
            expect(Modal.show).toHaveBeenCalledOnce();
            expect(revoke).toHaveBeenCalledWith('blob:private-image');
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });

    it('does not fetch or render HTML until explicit Download, and downloads verified bytes', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('html', 'text/html');
        const downloaded: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected binary download Blob');
            downloaded.push(blob); return 'blob:download';
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = installDownloadDocument();
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="html" name="page.html" {...source} />);
            expect(source.request).not.toHaveBeenCalled();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            await screen.pressByTestIdAsync('artifact:download');
            await waitForHomeGovernance(() => expect(anchor.click).toHaveBeenCalledOnce());
            expect(anchor.download).toBe('page.html');
            expect(anchor.click).toHaveBeenCalledOnce();
            expect(new Uint8Array(await downloaded[0]!.arrayBuffer())).toEqual(source.bytes);
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('does not disclose an Account-mode mismatch as a preview or download', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('image', 'image/png');
        source.request.mockImplementation(async () => new Response(JSON.stringify({ blobId: source.reference.blobId,
            content: { t: 'encrypted', c: 'AA==' } })));
        const createUrl = vi.spyOn(URL, 'createObjectURL');
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="image" name="image.png" {...source} />);
            await flushHookEffects();
            expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull();
            // A mismatch is final: Download would read the same refused bytes, so it is not offered.
            expect(screen.findByTestId('artifact:download')).toBeNull();
            expect(createUrl).not.toHaveBeenCalled();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
});

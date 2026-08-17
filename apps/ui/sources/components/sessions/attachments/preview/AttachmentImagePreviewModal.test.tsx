import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installSessionAttachmentCommonModuleMocks } from '@/components/sessions/attachments/sessionAttachmentTestHelpers';

const announceAccessibilityMessage = vi.hoisted(() => vi.fn());

const actEnvironmentGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

type PreviewState =
    | { status: 'loaded'; uri: string; error: null }
    | { status: 'error'; uri: null; error: string };

const previewState = vi.hoisted(() => ({
    value: { status: 'loaded', uri: 'data:image/png;base64,.happier/uploads/messages/m1/file.png', error: null } as PreviewState,
}));

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock({
        useWindowDimensions: () => ({ width: 900, height: 700 }),
    }),
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: (input: { enabled: boolean; filePath: string }) => {
        if (!input.enabled) {
            return { status: 'disabled', uri: null, error: null };
        }
        if (previewState.value.status === 'error') {
            return previewState.value;
        }
        return { ...previewState.value, uri: `data:image/png;base64,${input.filePath}` };
    },
}));

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage,
}));

describe('AttachmentImagePreviewModal', () => {
    const previousActEnvironment = actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT;

    beforeEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = true;
        previewState.value = { status: 'loaded', uri: 'data:image/png;base64,reset', error: null };
        announceAccessibilityMessage.mockClear();
    });

    afterEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    });

    it('renders the current direct image with inline width and height sizing for expo-image', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={setChrome}
            images={[
                { kind: 'direct', uri: 'blob:first', title: 'first.png' },
            ]}
            initialIndex={0}
        />);

        const image = screen.findByType('Image');
        expect(image.props.source).toEqual({ uri: 'blob:first' });
        expect(Array.isArray(image.props.style)).toBe(true);
        expect(image.props.style[0]).toEqual({ width: '100%', height: '100%' });
    });

    it('gives the web preview surface a viewport-constrained card height', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        const setChrome = vi.fn();

        await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={setChrome}
            images={[
                { kind: 'direct', uri: 'blob:first', title: 'first.png' },
            ]}
            initialIndex={0}
        />);

        expect(setChrome).toHaveBeenLastCalledWith(
            expect.objectContaining({
                kind: 'card',
                scrollHost: 'body',
                dimensions: expect.objectContaining({
                    width: expect.any(Number),
                    maxHeightRatio: expect.any(Number),
                }),
            }),
        );
    });

    it('preserves the native overlay-owned card layout', async () => {
        const { Platform } = await import('react-native');
        const mutablePlatform = Platform as { OS: string };
        const previousPlatform = mutablePlatform.OS;
        mutablePlatform.OS = 'ios';

        try {
            const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
            const setChrome = vi.fn();

            await renderScreen(<AttachmentImagePreviewModal
                onClose={() => {}}
                setChrome={setChrome}
                images={[
                    { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                ]}
                initialIndex={0}
            />);

            expect(setChrome).toHaveBeenLastCalledWith(
                expect.not.objectContaining({
                    scrollHost: expect.anything(),
                }),
            );
        } finally {
            mutablePlatform.OS = previousPlatform;
        }
    });

    it('keeps multi-image navigation accessible before hover and announces the selected image position', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        const { t } = await import('@/text');
        const setChrome = vi.fn();

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={setChrome}
            images={[
                { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                { kind: 'direct', uri: 'blob:second', title: 'second.png' },
            ]}
            initialIndex={0}
        />);

        const previous = screen.findByTestId('attachment-image-preview-previous');
        const next = screen.findByTestId('attachment-image-preview-next');

        expect(previous?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: t('common.previous'),
            accessibilityState: { disabled: true },
        });
        expect(next?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: t('common.next'),
            accessibilityState: { disabled: false },
        });
        expect(screen.findByType('Image').props.accessibilityLabel).toBe(
            t('files.sessionMedia.previewImageA11y', {
                name: 'first.png',
                current: 1,
                total: 2,
            }),
        );

        await screen.pressByTestIdAsync('attachment-image-preview-next');

        expect(screen.findByType('Image').props.source).toEqual({ uri: 'blob:second' });
        expect(screen.findByType('Image').props.accessibilityLabel).toBe(
            t('files.sessionMedia.previewImageA11y', {
                name: 'second.png',
                current: 2,
                total: 2,
            }),
        );
        expect(announceAccessibilityMessage).toHaveBeenLastCalledWith(
            t('files.sessionMedia.previewImageA11y', {
                name: 'second.png',
                current: 2,
                total: 2,
            }),
        );
    });

    it('navigates between direct images on native touch surfaces', async () => {
        const { Platform } = await import('react-native');
        const mutablePlatform = Platform as { OS: string };
        const previousPlatform = mutablePlatform.OS;
        mutablePlatform.OS = 'ios';
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        const setChrome = vi.fn();

        try {
            const screen = await renderScreen(<AttachmentImagePreviewModal
                onClose={() => {}}
                setChrome={setChrome}
                images={[
                    { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                    { kind: 'direct', uri: 'blob:second', title: 'second.png' },
                ]}
                initialIndex={0}
            />);

            await screen.pressByTestIdAsync('attachment-image-preview-next');

            expect(screen.findByType('Image').props.source).toEqual({ uri: 'blob:second' });
            expect(setChrome).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    kind: 'card',
                    title: 'second.png',
                    titleTestID: 'attachment-image-preview-title',
                }),
            );
        } finally {
            mutablePlatform.OS = previousPlatform;
        }
    });

    it('omits navigation for a single image and renders nothing for an empty gallery', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        const single = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={() => {}}
            images={[{ kind: 'direct', uri: 'blob:single', title: 'single.png' }]}
        />);

        expect(single.findAllByTestId('attachment-image-preview-previous')).toHaveLength(0);
        expect(single.findAllByTestId('attachment-image-preview-next')).toHaveLength(0);

        const empty = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={() => {}}
            images={[]}
        />);

        expect(empty.findAllByTestId('attachment-image-preview-surface')).toHaveLength(0);
    });

    it('renders session-backed images through the shared session preview hook', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={setChrome}
            images={[
                {
                    kind: 'session-image',
                    title: 'from-transcript.png',
                    sessionId: 's1',
                    filePath: '.happier/uploads/messages/m1/file.png',
                    mimeType: 'image/png',
                    sizeBytes: 10,
                    cacheKey: 'hash',
                },
            ]}
            initialIndex={0}
        />);

        expect(screen.findByType('Image').props.source).toEqual({
            uri: 'data:image/png;base64,.happier/uploads/messages/m1/file.png',
        });
    });

    it('renders an opaque staged composer image through the same preview hook without a source path or URI input', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={setChrome}
            images={[{
                kind: 'composer-staged-image',
                title: 'incident.png',
                handle: {
                    v: 1,
                    id: 'stage_42',
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    owner: { pluginId: 'acme.images', localId: 'image' },
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    name: 'incident.png',
                    sizeBytes: 3,
                    sha256: 'a'.repeat(64),
                },
            }]}
        />);

        expect(screen.findByType('Image').props.source).toEqual({
            uri: 'data:image/png;base64,incident.png',
        });
    });

    it('shows a generic localized error instead of raw preview details', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        previewState.value = { status: 'error', uri: null, error: 'internal disk path leaked' };
        const setChrome = vi.fn();

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            setChrome={setChrome}
            images={[
                {
                    kind: 'session-image',
                    title: 'broken.png',
                    sessionId: 's1',
                    filePath: '.happier/uploads/messages/m1/file.png',
                    mimeType: 'image/png',
                    sizeBytes: 10,
                    cacheKey: 'hash',
                },
            ]}
            initialIndex={0}
        />);

        const textNodes = screen.findAll((node) => node.props?.children === 'common.error');
        expect(textNodes.length).toBeGreaterThan(0);
        expect(() => screen.find((node) => node.props?.children === 'internal disk path leaked')).toThrow();
    });
});

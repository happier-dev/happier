import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createHostApiStub, createSurfaceContext } from '../../../../../../packages/plugin-ui/src/surfaceFixture.testSupport';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

import { StoredImage } from '@happier-dev/plugin-ui';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';
import { CorePluginUiPresentationScope } from './CorePluginUiPresentationScope';
import { MediaStage } from '@/components/ui/media/stage/MediaStage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider, useModal } from '@/modal';

describe('mounted same-realm media stage', () => {
    it('uses the admitted PNG result for StoredImage stage backing', async () => {
        const context = createSurfaceContext();
        // Reading admitted bytes is the plugin host API boundary; all presentation owners stay real.
        const hostApi = createHostApiStub(context, { readStoredImage: async () => ({
            bytesBase64: 'cG5n', mimeType: 'image/png', width: 100, height: 60,
        }) });
        let modal!: ReturnType<typeof useModal>;
        function ObserveModal() { modal = useModal(); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider>
            <ObserveModal />
            <PluginUiProvider hostApi={hostApi} context={context}>
                <CorePluginUiPresentationScope>
                    <StoredImage accessibilityLabel="Capture" testID="stored-capture" image={{
                        mediaId: 'media-1', mediaKind: 'image', width: 100, height: 60, sizeBytes: 24,
                        file: { sessionId: 'session-1', storage: 'daemon', path: '.happier/uploads/artifacts/session-1/image.png',
                            sha256: 'a'.repeat(64), mimeType: 'image/png' },
                    }} />
                </CorePluginUiPresentationScope>
            </PluginUiProvider>
        </ModalProvider></InjectedAuthProvider>);
        try {
            expect(modal.state.modals).toHaveLength(0);
            await screen.pressByTestIdAsync('stored-capture');
            expect(modal.state.modals).toHaveLength(1);
            expect(screen.findAllByType(MediaStage)).toHaveLength(1);
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 60 } }));
            expect(screen.findAllHostsByTestId('media-stage-image-checkerboard')).toHaveLength(1);
            expect(screen.findByType(MediaStage).props.items).toEqual([{ kind: 'image', title: 'Capture', alphaCapable: true,
                source: { enabled: true, mimeType: 'image/png', source: { kind: 'uri', uri: 'data:image/png;base64,cG5n' } } }]);
            await act(async () => modal.hideAllModals());
            expect(screen.findAllByType(MediaStage)).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });
});

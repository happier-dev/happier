import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';
import type { CustomModalChromeCardConfig } from '@/modal/types';

const viewport = vi.hoisted(() => ({ width: 393, height: 852 }));

// A phone-sized Android window: the card owner presents the Connect sheet as a bottom sheet.
installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock(
            { platformOS: 'android' },
            {
                useWindowDimensions: () => viewport,
                Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
            },
        );
    },
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const { Modal } = await import('@/modal');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
const { presentConnectSheet } = await import('./ConnectedServiceSetupModal');
const { useConnectSheetHeading } = await import('./useConnectSheetHeading');

type Chrome = Partial<CustomModalChromeCardConfig>;

// P03-PROFILE-ROUND-2 #9: on Android the service catalog stopped at Kimi Code; Muse and later tiles could not be
// reached. The card picks its native body (a still View or a ScrollView) once, at presentation, so the chrome the
// sheet is presented with must already carry the body scroll its content then publishes with its heading.
describe('Connect sheet body on native', () => {
    it('presents an account sheet whose body scrolls, so the last service tile is reachable', async () => {
        void presentConnectSheet({ intent: 'link' });
        const shown = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        const request = shown.props!.request;

        function Content(props: Readonly<{ setChrome: (chrome: Chrome) => void }>) {
            useConnectSheetHeading({ request, onResult: () => {}, setChrome: props.setChrome } as never, {
                title: 'Connect a service',
                subtitle: 'Saved to your account',
                leading: null,
                leadingKey: 'catalog',
            });
            return React.createElement('Catalog');
        }
        // The modal host merges the content's chrome over the presented chrome (CustomModal).
        function Host() {
            const [chrome, setChrome] = React.useState<Chrome>(shown.chrome as Chrome);
            const merge = React.useCallback((next: Chrome) => setChrome(previous => ({ ...previous, ...next })), []);
            return (
                <ModalCardFrame presentation="sheet" scrollHost={chrome.scrollHost} bodyScroll={chrome.bodyScroll}
                    title={chrome.title} dimensions={chrome.dimensions}>
                    <Content setChrome={merge} />
                </ModalCardFrame>
            );
        }

        const screen = await renderScreen(<Host />);
        const scrollers = screen.findAllByType('ScrollView').filter(node => node.props.scrollEnabled === true);
        expect(scrollers).toHaveLength(1);
    });
});

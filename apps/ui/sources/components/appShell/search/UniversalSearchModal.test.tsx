import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { renderScreen as renderScreenWithTestkit, standardCleanup } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from '@/components/sessions/new/components/newSessionComponentsTestHelpers';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { afterAll } from 'vitest';

const capturedChrome = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

const setChrome: NonNullable<import('@/modal/types').CustomModalInjectedProps['setChrome']> = chrome => {
    capturedChrome.value = chrome;
};

installNewSessionComponentsCommonModuleMocks({ text: () => createTextModuleMock({
    translate: key => key === 'tools.names.search' ? 'Search' : key,
}) });
vi.unmock('@/sync/domains/state/storage');
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { UniversalSearchController } = await import('./UniversalSearchController');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const AppProviders = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>;
function renderScreen(element: React.ReactElement) { return renderScreenWithTestkit(element, { wrapper: AppProviders }); }
afterAll(() => network.dispose());

afterEach(() => {
    capturedChrome.value = null;
    standardCleanup();
});

describe('UniversalSearchModal', () => {
    it('uses the bounded card seam while leaving SelectionList as the sole scroll owner', async () => {
        const { UniversalSearchModal } = await import('./UniversalSearchModal');

        await renderScreen(
            <UniversalSearchModal
                commands={[]}
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );

        expect(capturedChrome.value).toEqual(expect.objectContaining({
            header: 'none',
            title: 'Search',
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 640, maxHeightRatio: 0.7, size: 'lg' },
            // A phone-width window is a phone: Search fills it (lab G1sp), never a floating card.
            phonePresentation: 'fullscreen',
        }));
    });

    // Lab G1 / G1s: Everything is a compact palette; Text in files (and the conversation results) widen it
    // for the detail column beside the list. Once wide, the open card never narrows under the pointer
    // (removing the scope chip used to shrink it from 960 to 640).
    it('widens the card for a detail mode and keeps that width while it stays open', async () => {
        const { UniversalSearchModal } = await import('./UniversalSearchModal');
        const screen = await renderScreen(<UniversalSearchModal commands={[]} onClose={vi.fn()} setChrome={setChrome} />);
        const setLayout = screen.findByType(UniversalSearchController).props.onSurfaceLayoutChange as ((layout: 'compact' | 'detail') => void) | undefined;
        expect(setLayout).toBeTypeOf('function');
        await act(async () => { setLayout!('detail'); });
        expect((capturedChrome.value?.dimensions as { width: number }).width).toBe(960);
        await act(async () => { setLayout!('compact'); });
        expect((capturedChrome.value?.dimensions as { width: number }).width).toBe(960);
    });
});

import * as React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const DELETED_LEGACY_CHAT_LIST_HARNESS_EXPORTS = [
    ['legacy', 'ChatListHarnessState'].join(''),
    ['render', 'LegacyChatList'].join(''),
    ['reset', 'LegacyChatListHarness'].join(''),
    ['trigger', 'LegacyChatListScroll'].join(''),
    ['trigger', 'LegacyChatListInitialFill'].join(''),
    ['trigger', 'LegacyChatListEndReached'].join(''),
    ['get', 'CapturedFlatListProps'].join(''),
    ['require', 'CapturedFlatListProps'].join(''),
    ['build', 'LegacyChatListItems'].join(''),
    ['create', 'LegacyChatListItemsModuleMock'].join(''),
    ['create', 'LegacyChatListReactNativeMock'].join(''),
    ['create', 'LegacyChatListStorageMock'].join(''),
];

describe('chatListHarness', () => {
    it('does not export deleted legacy ChatList harness compatibility aliases', async () => {
        const harnessModule = await import('./chatListHarness');

        for (const deletedExport of DELETED_LEGACY_CHAT_LIST_HARNESS_EXPORTS) {
            expect(harnessModule).not.toHaveProperty(deletedExport);
        }
    });

    it('captures FlashList props and drives initial fill for FlashList ChatList tests', async () => {
        const harnessModule = await import('./chatListHarness');

        const resetFlashListChatListHarness = Reflect.get(harnessModule, 'resetFlashListChatListHarness');
        const createFlashListChatListModuleMock = Reflect.get(harnessModule, 'createFlashListChatListModuleMock');
        const requireCapturedFlashListProps = Reflect.get(harnessModule, 'requireCapturedFlashListProps');
        const triggerFlashListChatListInitialFill = Reflect.get(harnessModule, 'triggerFlashListChatListInitialFill');
        const triggerFlashListChatListLoad = Reflect.get(harnessModule, 'triggerFlashListChatListLoad');

        expect(typeof resetFlashListChatListHarness).toBe('function');
        expect(typeof createFlashListChatListModuleMock).toBe('function');
        expect(typeof requireCapturedFlashListProps).toBe('function');
        expect(typeof triggerFlashListChatListInitialFill).toBe('function');
        expect(typeof triggerFlashListChatListLoad).toBe('function');

        if (
            typeof resetFlashListChatListHarness !== 'function' ||
            typeof createFlashListChatListModuleMock !== 'function' ||
            typeof requireCapturedFlashListProps !== 'function' ||
            typeof triggerFlashListChatListInitialFill !== 'function' ||
            typeof triggerFlashListChatListLoad !== 'function'
        ) {
            return;
        }

        resetFlashListChatListHarness();

        const flashListModule = await createFlashListChatListModuleMock();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();
        const onLoad = vi.fn();
        const ref = React.createRef<unknown>();
        const FlashListComponent = flashListModule.FlashList as any;

        await act(async () => {
            FlashListComponent.render?.(
                {
                    ref,
                    data: [],
                    onLoad,
                    onLayout,
                    onContentSizeChange,
                },
                ref,
            );
        });

        const capturedFlashListProps = requireCapturedFlashListProps();
        expect(capturedFlashListProps.onLayout).toBe(onLayout);
        expect(capturedFlashListProps.onContentSizeChange).toBe(onContentSizeChange);

        await triggerFlashListChatListLoad(42);

        expect(onLoad).toHaveBeenCalledWith({ elapsedTimeInMs: 42 });

        await triggerFlashListChatListInitialFill({
            layoutHeight: 320,
            layoutWidth: 400,
            contentHeight: 960,
            contentWidth: 400,
        });

        expect(onLayout).toHaveBeenCalledWith({
            nativeEvent: {
                layout: {
                    height: 320,
                    width: 400,
                },
            },
        });
        expect(onContentSizeChange).toHaveBeenCalledWith(400, 960);
    });

    it('mocks FlashList v2 recycling hooks through the ChatList FlashListCompat module mock', async () => {
        const harnessModule = await import('./chatListHarness');
        const resetFlashListChatListHarness = Reflect.get(harnessModule, 'resetFlashListChatListHarness');
        const createFlashListChatListModuleMock = Reflect.get(harnessModule, 'createFlashListChatListModuleMock');

        expect(typeof resetFlashListChatListHarness).toBe('function');
        expect(typeof createFlashListChatListModuleMock).toBe('function');
        if (
            typeof resetFlashListChatListHarness !== 'function' ||
            typeof createFlashListChatListModuleMock !== 'function'
        ) {
            return;
        }

        resetFlashListChatListHarness();
        const flashListModule = await createFlashListChatListModuleMock();
        const observedValues: Array<Readonly<{
            layoutValue: number;
            mappingKey: string | number | bigint;
            recyclingValue: string;
        }>> = [];
        const onCommitLayoutEffect = vi.fn();
        const LayoutCommitObserver = flashListModule.LayoutCommitObserver as React.ComponentType<{
            children: React.ReactNode;
            onCommitLayoutEffect?: () => void;
        }>;

        function HookProbe() {
            const { getMappingKey } = flashListModule.useMappingHelper();
            const [layoutValue, setLayoutValue] = flashListModule.useLayoutState(1);
            const [recyclingValue, setRecyclingValue] = flashListModule.useRecyclingState('initial', ['stable']);

            React.useEffect(() => {
                setLayoutValue(2);
                setRecyclingValue('updated');
            }, [setLayoutValue, setRecyclingValue]);

            observedValues.push({
                layoutValue,
                mappingKey: getMappingKey('message-1', 5),
                recyclingValue,
            });

            return null;
        }

        await act(async () => {
            renderer.create(
                <LayoutCommitObserver onCommitLayoutEffect={onCommitLayoutEffect}>
                    <HookProbe />
                </LayoutCommitObserver>,
            );
        });

        expect(observedValues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    layoutValue: 1,
                    mappingKey: 5,
                    recyclingValue: 'initial',
                }),
                expect.objectContaining({
                    layoutValue: 2,
                    mappingKey: 5,
                    recyclingValue: 'updated',
                }),
            ]),
        );
        expect(onCommitLayoutEffect).toHaveBeenCalled();
    });

    it('derives Sync tuning defaults from the runtime loader', async () => {
        const harnessModule = await import('./chatListHarness');
        const { loadSyncTuning } = await import('@/sync/runtime/syncTuning');
        const resetFlashListChatListHarness = Reflect.get(harnessModule, 'resetFlashListChatListHarness');
        const createFlashListChatListSyncModuleMock = Reflect.get(harnessModule, 'createFlashListChatListSyncModuleMock');

        expect(typeof resetFlashListChatListHarness).toBe('function');
        expect(typeof createFlashListChatListSyncModuleMock).toBe('function');
        if (
            typeof resetFlashListChatListHarness !== 'function' ||
            typeof createFlashListChatListSyncModuleMock !== 'function'
        ) {
            return;
        }

        resetFlashListChatListHarness();
        const syncModule = createFlashListChatListSyncModuleMock();
        const tuning = syncModule.sync.getSyncTuning();
        const defaults = loadSyncTuning();

        expect(tuning.transcriptMaxTurnEntriesPerListItem).toBe(defaults.transcriptMaxTurnEntriesPerListItem);
        expect(tuning.transcriptMountSettleQuiescentWindowMs).toBe(defaults.transcriptMountSettleQuiescentWindowMs);

        resetFlashListChatListHarness({
            syncTuningState: {
                transcriptWebHotTailItemCount: 3,
            },
        });

        const overriddenTuning = createFlashListChatListSyncModuleMock().sync.getSyncTuning();
        expect(overriddenTuning.transcriptWebHotTailItemCount).toBe(3);
        expect(overriddenTuning.transcriptMaxTurnEntriesPerListItem).toBe(defaults.transcriptMaxTurnEntriesPerListItem);
    });

    it('supplies an empty remote user-message history page by default', async () => {
        const harnessModule = await import('./chatListHarness');
        const createFlashListChatListSyncModuleMock = Reflect.get(harnessModule, 'createFlashListChatListSyncModuleMock');

        expect(typeof createFlashListChatListSyncModuleMock).toBe('function');
        if (typeof createFlashListChatListSyncModuleMock !== 'function') {
            return;
        }

        const syncModule = createFlashListChatListSyncModuleMock();
        const fetchUserMessageHistoryPage = Reflect.get(syncModule.sync, 'fetchUserMessageHistoryPage');
        expect(typeof fetchUserMessageHistoryPage).toBe('function');
        if (typeof fetchUserMessageHistoryPage !== 'function') {
            return;
        }

        await expect(fetchUserMessageHistoryPage('session-1', { limit: 40 })).resolves.toEqual({
            status: 'loaded',
            rows: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
    });

    it('creates reusable fake web elements for transcript DOM anchoring scenarios', async () => {
        const harnessModule = await import('./chatListHarness');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');
        const FlashListChatListWebElement = Reflect.get(harnessModule, 'FlashListChatListWebElement');

        expect(typeof createFlashListChatListWebElement).toBe('function');
        expect(typeof FlashListChatListWebElement).toBe('function');
        if (typeof createFlashListChatListWebElement !== 'function') {
            return;
        }

        const parent = createFlashListChatListWebElement(null, { top: 0, bottom: 400 });
        const child = createFlashListChatListWebElement('transcript-item-u1', { top: 50, bottom: 150 });

        parent.setQuerySelectorAll('[data-testid]', [child]);
        child.parentElement = parent;

        expect(child.getAttribute('data-testid')).toBe('transcript-item-u1');
        expect(parent.querySelectorAll('[data-testid]')).toEqual([child]);
        expect(child.getBoundingClientRect().top).toBe(50);

        child.setRect({ top: 80, bottom: 180 });
        expect(child.getBoundingClientRect().bottom).toBe(180);
        expect(parent.contains(parent)).toBe(true);
        expect(parent.contains(child)).toBe(false);
    });

    it('creates a clamped FlashList web scroller for transcript prepend-anchor scenarios', async () => {
        const harnessModule = await import('./chatListHarness');
        const createFlashListChatListWebScroller = Reflect.get(harnessModule, 'createFlashListChatListWebScroller');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');

        expect(typeof createFlashListChatListWebScroller).toBe('function');
        expect(typeof createFlashListChatListWebElement).toBe('function');
        if (
            typeof createFlashListChatListWebScroller !== 'function'
            || typeof createFlashListChatListWebElement !== 'function'
        ) {
            return;
        }

        const anchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 999,
            testNodes: [anchor],
        });

        expect(scroller.scrollTop).toBe(600);
        expect(scroller.querySelectorAll('[data-testid]')).toEqual([anchor]);

        scroller.scrollTop = -50;
        expect(scroller.scrollTop).toBe(0);

        scroller.scrollTop = 5000;
        expect(scroller.scrollTop).toBe(600);
    });

    it('installs and restores a custom HTMLElement while the web scroller DOM helper runs', async () => {
        const harnessModule = await import('./chatListHarness');
        const withFlashListChatListWebScrollerDom = Reflect.get(harnessModule, 'withFlashListChatListWebScrollerDom');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');
        const FlashListChatListWebElement = Reflect.get(harnessModule, 'FlashListChatListWebElement');

        expect(typeof withFlashListChatListWebScrollerDom).toBe('function');
        expect(typeof createFlashListChatListWebElement).toBe('function');
        expect(typeof FlashListChatListWebElement).toBe('function');
        if (
            typeof withFlashListChatListWebScrollerDom !== 'function'
            || typeof createFlashListChatListWebElement !== 'function'
            || typeof FlashListChatListWebElement !== 'function'
        ) {
            return;
        }

        const previousHTMLElement = (globalThis as any).HTMLElement;
        const scroller = createFlashListChatListWebElement(null, { top: 0, bottom: 300 });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                expect((globalThis as any).HTMLElement).toBe(FlashListChatListWebElement);
                expect((globalThis as any).document.querySelector()).toBe(scroller);
            },
            { HTMLElement: FlashListChatListWebElement },
        );

        expect((globalThis as any).HTMLElement).toBe(previousHTMLElement);
    });

    it('provides the document event and focus boundary used by web transcript keyboard ownership', async () => {
        const harnessModule = await import('./chatListHarness');
        const withFlashListChatListWebScrollerDom = Reflect.get(harnessModule, 'withFlashListChatListWebScrollerDom');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');
        const FlashListChatListWebElement = Reflect.get(harnessModule, 'FlashListChatListWebElement');

        expect(typeof withFlashListChatListWebScrollerDom).toBe('function');
        expect(typeof createFlashListChatListWebElement).toBe('function');
        expect(typeof FlashListChatListWebElement).toBe('function');
        if (
            typeof withFlashListChatListWebScrollerDom !== 'function'
            || typeof createFlashListChatListWebElement !== 'function'
            || typeof FlashListChatListWebElement !== 'function'
        ) {
            return;
        }

        const scroller = createFlashListChatListWebElement(null, { top: 0, bottom: 300 });
        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const installedDocument = globalThis.document;
                const onKeyDown = vi.fn();

                expect(installedDocument.activeElement).toBe(installedDocument.body);
                installedDocument.addEventListener('keydown', onKeyDown, true);
                installedDocument.dispatchEvent(new Event('keydown'));
                expect(onKeyDown).toHaveBeenCalledTimes(1);

                scroller.focus({ preventScroll: true });
                expect(installedDocument.activeElement).toBe(scroller);

                installedDocument.removeEventListener('keydown', onKeyDown, true);
                installedDocument.dispatchEvent(new Event('keydown'));
                expect(onKeyDown).toHaveBeenCalledTimes(1);
            },
            { HTMLElement: FlashListChatListWebElement },
        );
    });

    it('renders a FlashList chat list inside the installed web scroller DOM and returns the harness', async () => {
        vi.doMock('@/components/sessions/transcript/ChatList', () => ({
            ChatList: () => React.createElement('MockChatList'),
        }));

        try {
            const harnessModule = await import('./chatListHarness');
            const withRenderedFlashListChatListWebScroller = Reflect.get(harnessModule, 'withRenderedFlashListChatListWebScroller');
            const createFlashListChatListWebScroller = Reflect.get(harnessModule, 'createFlashListChatListWebScroller');

            expect(typeof withRenderedFlashListChatListWebScroller).toBe('function');
            expect(typeof createFlashListChatListWebScroller).toBe('function');
            if (
                typeof withRenderedFlashListChatListWebScroller !== 'function'
                || typeof createFlashListChatListWebScroller !== 'function'
            ) {
                return;
            }

            const scroller = createFlashListChatListWebScroller({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 200,
            });

            await withRenderedFlashListChatListWebScroller(
                scroller,
                React.createElement('MockChatList'),
                async (screen: any) => {
                    expect((globalThis as any).document.querySelector()).toBe(scroller);
                    expect(screen.findByType('MockChatList')).toBeTruthy();
                },
                {
                    initialFill: false,
                    dom: { HTMLElement: Reflect.get(harnessModule, 'FlashListChatListWebElement') },
                },
            );
        } finally {
            vi.doUnmock('@/components/sessions/transcript/ChatList');
            vi.resetModules();
        }
    });
});

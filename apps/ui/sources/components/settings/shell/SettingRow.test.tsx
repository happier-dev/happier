import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { View } from 'react-native';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
// Prepare the real owner graph during collection, before individual tests enable fake timers.
import { SettingAnchor, SettingSection, SettingRow, useSettingRevealRequested } from './SettingRow';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const paramsState = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', Text: 'Text', Pressable: 'Pressable' });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => paramsState.value }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// This third-party SDK export is unavailable on some workers and is never used by setting anchors.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in setting anchor test'); },
}));

const { MEMORY_SETTINGS: PAGE } = await import('@/components/settings/memory/memorySettings');

async function renderPage(requested: string, rowMounted: boolean) {
    paramsState.value = { setting: requested };
    const screen = await renderScreen(
        <>
            <SettingSection section={PAGE.sectionRefs.indexing}>
                <React.Fragment>
                    {rowMounted ? <SettingRow setting={PAGE.settings.indexMode} /> : null}
                    <SettingRow setting={PAGE.settings.backfill} />
                </React.Fragment>
            </SettingSection>
            <SettingSection section={PAGE.sectionRefs.localIndex}>
                <SettingRow setting={PAGE.settings.enabled} />
            </SettingSection>
        </>,
    );
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
    return screen;
}

describe('SettingSection', () => {
    afterEach(() => {
        vi.useRealTimers();
        paramsState.value = {};
    });

    it('reveals only the matching group and opens again for a different setting request in that group', async () => {
        paramsState.value = { setting: PAGE.settings.indexMode.anchor };
        function Group(props: { testID: string; settings: readonly typeof PAGE.settings.indexMode[] }) {
            const [expanded, setExpanded] = React.useState(false);
            return <SettingAnchor settings={props.settings}>
                <ExpandableItem expanded={expanded} onExpandedChange={setExpanded}
                    header={(state) => <View testID={`${props.testID}.header`} {...state.headerProps} />}>
                    <View testID={`${props.testID}.content`} />
                </ExpandableItem>
            </SettingAnchor>;
        }
        const render = () => <SettingSection section={PAGE.sectionRefs.indexing}>
            <Group testID="target" settings={[PAGE.settings.indexMode, PAGE.settings.backfill]} />
            <Group testID="neighbor" settings={[PAGE.settings.enabled]} />
        </SettingSection>;
        const screen = await renderScreen(render());
        expect(screen.findByTestId('target.content')).not.toBeNull();
        expect(screen.findByTestId('neighbor.content')).toBeNull();
        await act(async () => screen.findByTestId('target.header')!.props.onPress());
        expect(screen.findByTestId('target.header')!.props.accessibilityState.expanded).toBe(false);
        paramsState.value = { setting: PAGE.settings.backfill.anchor };
        await act(async () => screen.update(render()));
        expect(screen.findByTestId('target.content')).not.toBeNull();
        expect(screen.findByTestId('neighbor.content')).toBeNull();
    });

    it('lets the requested row reveal itself when the page renders it', async () => {
        vi.useFakeTimers();
        const screen = await renderPage(PAGE.settings.indexMode.anchor, true);

        expect(screen.findByTestId(`setting-reveal.${PAGE.settings.indexMode.anchor}`)).toBeTruthy();
        expect(screen.findByTestId(`setting-reveal.${PAGE.sectionRefs.indexing.id}`)).toBeNull();
    });

    it('reveals the enclosing section when the page does not render the requested row', async () => {
        vi.useFakeTimers();
        const screen = await renderPage(PAGE.settings.indexMode.anchor, false);

        expect(screen.findByTestId(`setting-reveal.${PAGE.sectionRefs.indexing.id}`)).toBeTruthy();
        // Only the section that holds the row answers; its neighbours stay quiet.
        expect(screen.findByTestId(`setting-reveal.${PAGE.sectionRefs.localIndex.id}`)).toBeNull();
    });

    it('lets a rendered section answer for a section the page does not render in its state', async () => {
        vi.useFakeTimers();
        paramsState.value = { setting: PAGE.settings.enabled.anchor };
        // Only `content` is on screen (say, until a machine is chosen); it explains `other`'s rows too.
        const screen = await renderScreen(
            <SettingSection section={PAGE.sectionRefs.indexing} answersFor={[PAGE.sectionRefs.localIndex]}>
                <SettingRow setting={PAGE.settings.backfill} />
            </SettingSection>,
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });

        expect(screen.findByTestId(`setting-reveal.${PAGE.sectionRefs.indexing.id}`)).toBeTruthy();
    });

    it('lets route and virtualized owners inspect the requested setting', async () => {
        paramsState.value = { setting: PAGE.settings.backfill.anchor };
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const inside = await renderHook(() => useSettingRevealRequested([PAGE.settings.indexMode, PAGE.settings.backfill]));
        expect(inside.getCurrent()).toBe(true);
        await inside.unmount();
        const outside = await renderHook(() => useSettingRevealRequested([PAGE.settings.enabled]));
        expect(outside.getCurrent()).toBe(false);
        await outside.unmount();
    });

    it('reveals only the anchor requested by each concurrently hosted page', async () => {
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        function RevealRequestProbe() {
            return React.createElement('RevealRequestProbe', {
                requested: useSettingRevealRequested([PAGE.settings.indexMode]),
            });
        }
        paramsState.value = { setting: PAGE.settings.indexMode.anchor };
        const screen = await renderScreen(<>
            <DestinationInstanceHost tabId="a" ref={{ kind: 'settings', params: { setting: PAGE.settings.indexMode.anchor } }} pathname="/settings/memory" focused visible>
                <RevealRequestProbe />
            </DestinationInstanceHost>
            <DestinationInstanceHost tabId="b" ref={{ kind: 'settings', params: { setting: PAGE.settings.backfill.anchor } }} pathname="/settings/memory" focused={false} visible>
                <RevealRequestProbe />
            </DestinationInstanceHost>
        </>);
        expect(screen.root.findAllByType('RevealRequestProbe').map((node) => node.props.requested)).toEqual([true, false]);
    });

    it('reveals the missing row section even when another tab renders that same requested row', async () => {
        vi.useFakeTimers();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const screen = await renderScreen(<>
            {[true, false].map((rowMounted, index) => <DestinationInstanceHost key={index}
                tabId={`settings-${index}`} ref={{ kind: 'settings', params: { setting: PAGE.settings.indexMode.anchor } }}
                pathname="/settings/memory" focused={index === 0} visible>
                <SettingSection section={PAGE.sectionRefs.indexing}>
                    {rowMounted ? <SettingRow setting={PAGE.settings.indexMode} /> : null}
                </SettingSection>
            </DestinationInstanceHost>)}
        </>);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.findAllHostsByTestId(`setting-reveal.${PAGE.settings.indexMode.anchor}`)).toHaveLength(1);
        expect(screen.findAllHostsByTestId(`setting-reveal.${PAGE.sectionRefs.indexing.id}`)).toHaveLength(1);
    });
});

describe('SettingAnchor divider', () => {
    it('passes the section divider to a single row but never to a fragment of rows', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        function Row(props: { testID: string; showDivider?: boolean }) {
            return <View testID={props.testID} accessibilityHint={String(props.showDivider)} />;
        }
        try {
            const tree = () => <>
                <SettingAnchor setting={PAGE.settings.indexMode} showDivider={false}>
                    <Row testID="single" />
                </SettingAnchor>
                <SettingAnchor setting={PAGE.settings.backfill} showDivider={false}>
                    <>
                        <Row testID="first" showDivider />
                        <Row testID="last" />
                    </>
                </SettingAnchor>
            </>;
            const screen = await renderScreen(tree());
            // React checks a fragment's props when it reconciles an existing one, so render twice.
            await act(async () => screen.update(tree()));
            expect(screen.findByTestId('single')!.props.accessibilityHint).toBe('false');
            expect(screen.findByTestId('first')!.props.accessibilityHint).toBe('true');
            expect(errors.mock.calls.some((call) => call.some((part) => String(part).includes('React.Fragment')))).toBe(false);
            await screen.unmount();
        } finally { errors.mockRestore(); }
    });
});

import * as React from 'react';
import { registerVoiceSetupPresentation, setVoiceSetupOpen } from '@/components/voice/presence/voiceCompanionSectionReveal';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Color from 'color';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { dispatchEscapeToLayerStack } from '@/keyboard/escape';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// The host's reduce-motion preference (an OS / media-query boundary).
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => motion.reduced,
    readReducedMotionPreference: () => motion.reduced,
}));
// The panel unmounts when its collapse lands, so the canonical reanimated mock settles `withTiming`.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});

afterEach(() => {
    standardCleanup();
    motion.reduced = false;
});

/** A panel that records whether it is mounted: what the pairing session's lifetime follows. */
function ProbePanel(props: Readonly<{ close: () => void; lifecycle: string[] }>) {
    React.useEffect(() => {
        props.lifecycle.push('mount');
        return () => { props.lifecycle.push('unmount'); };
    }, [props.lifecycle]);
    return (
        <View testID="probe-panel">
            <Pressable testID="probe-panel.close" onPress={props.close}><Text>close</Text></Pressable>
        </View>
    );
}

async function renderGrid(lifecycle: string[]) {
    const { SetupBlockGrid } = await import('./SetupBlockGrid');
    const tile = (id: string) => ({ open }: Readonly<{ open: () => void }>) => (
        <Pressable testID={`tile.${id}.action`} onPress={open}><Text>{id}</Text></Pressable>
    );
    const screen = await renderScreen(
        <SetupBlockGrid
            testID="morph"
            items={[
                { id: 'phone', renderTile: tile('phone'), renderPanel: ({ close }) => <ProbePanel close={close} lifecycle={lifecycle} /> },
                { id: 'machine', renderTile: tile('machine') },
                { id: 'computer', renderTile: tile('computer') },
            ]}
        />,
    );
    await flushHookEffects({ cycles: 2 });
    return screen;
}

function isCovered(screen: Awaited<ReturnType<typeof renderGrid>>, id: string): boolean {
    const slot = screen.findByTestId(`morph.slot.${id}`);
    expect(slot).toBeTruthy();
    return slot!.props.accessibilityElementsHidden === true;
}

describe('SetupBlockGrid', () => {
    it('borrows the existing setup opening and closing controls for mounted presentation commands', async () => {
        const { SetupBlockGrid } = await import('./SetupBlockGrid');
        const lifecycle: string[] = [];
        const screen = await renderScreen(<SetupBlockGrid testID="voice-setup" items={[{
            id: 'voice',
            registerPresentation: ({ open, close }) => registerVoiceSetupPresentation((expanded) => { if (expanded) open(); else close(); }),
            renderTile: ({ open }) => <Pressable testID="voice-setup-tile" onPress={open}><Text>Voice</Text></Pressable>,
            renderPanel: ({ close }) => <ProbePanel close={close} lifecycle={lifecycle} />,
        }]} />);
        await act(async () => { expect(setVoiceSetupOpen(true)).toBe(true); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('probe-panel')).toBeTruthy();
        await act(async () => { expect(setVoiceSetupOpen(false)).toBe(true); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('probe-panel')).toBeNull();
        expect(lifecycle).toEqual(['mount', 'unmount']);
        await screen.unmount();
        expect(setVoiceSetupOpen(true)).toBe(false);
    });
    it('keeps setup paper, expanded frames and path columns within their containing material', async () => {
        const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const { SetupBlockGrid } = await import('./SetupBlockGrid');
        const { SetupBlockPaper } = await import('./SetupBlockPaper');
        const { SetupPathPanel } = await import('./SetupPathPanel');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        for (const reduceTransparency of [false, true]) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency }}>
                <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                    <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320} titleStrip={null} rail={null} column={null} peek={null}>
                        <SetupBlockGrid testID="material-setup" openId="machine" items={[{ id: 'machine',
                            renderTile: () => <SetupBlockPaper testID="material-setup-paper" layout="card"><Text>Machine</Text></SetupBlockPaper>,
                            renderPanel: ({ close }) => <SetupPathPanel testID="material-setup-path" title="Add machine" active="local" onChoose={() => {}} onClose={close}
                                paths={[{ id: 'local', title: 'Local', subtitle: 'This machine', glyph: null }]} pane={<Text>Details</Text>} />,
                        }]} />
                    </AppShellMaterialFrame>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
            const paper = StyleSheet.flatten(screen.findHostByTestId('material-setup-paper')!.props.style).backgroundColor;
            const frame = StyleSheet.flatten(screen.findHostByTestId('material-setup.panel')!.props.style).backgroundColor;
            const column = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)).find(style => style?.width === 264)!.backgroundColor;
            if (reduceTransparency) {
                expect(Color(paper).hexa()).toBe(Color(theme.colors.surface.base).hexa());
                expect(Color(frame).hexa()).toBe(Color(theme.colors.surface.base).hexa());
                expect(Color(column).hexa()).toBe(Color(theme.colors.surface.sectionTint).hexa());
            } else {
                expect(Color(paper).alpha()).toBeLessThan(1);
                expect(Color(frame).alpha()).toBe(0);
                expect(Color(column).alpha()).toBeLessThan(1);
            }
            standardCleanup();
        }
    });
    it('grows the pressed tile into its panel over the row, keeping every tile in its slot underneath', async () => {
        const lifecycle: string[] = [];
        const screen = await renderGrid(lifecycle);
        expect(screen.findByTestId('probe-panel')).toBeNull();

        await act(async () => { screen.pressByTestId('tile.phone.action'); });
        await flushHookEffects({ cycles: 2 });

        expect(screen.findByTestId('probe-panel')).toBeTruthy();
        expect(lifecycle).toEqual(['mount']);
        // The panel covers the row: the other tiles keep their slots (still mounted) but leave the
        // accessibility tree while covered, and the frame is marked as the open panel.
        expect(screen.findByTestId('tile.machine.action')).toBeTruthy();
        expect(screen.findByTestId('tile.computer.action')).toBeTruthy();
        expect(isCovered(screen, 'machine')).toBe(true);
        expect(isCovered(screen, 'computer')).toBe(true);
        expect(screen.findByTestId('morph.panel')).toBeTruthy();
    });

    it('runs backwards on the panel close and unmounts the panel once collapsed', async () => {
        const lifecycle: string[] = [];
        const screen = await renderGrid(lifecycle);
        await act(async () => { screen.pressByTestId('tile.phone.action'); });
        await flushHookEffects({ cycles: 2 });

        await act(async () => { screen.pressByTestId('probe-panel.close'); });
        await flushHookEffects({ cycles: 2 });

        expect(screen.findByTestId('probe-panel')).toBeNull();
        expect(lifecycle).toEqual(['mount', 'unmount']);
        expect(isCovered(screen, 'machine')).toBe(false);
        expect(screen.findByTestId('morph.panel')).toBeNull();
    });

    it('closes on Escape while open, and leaves Escape alone once closed', async () => {
        const lifecycle: string[] = [];
        const screen = await renderGrid(lifecycle);
        await act(async () => { screen.pressByTestId('tile.phone.action'); });
        await flushHookEffects({ cycles: 2 });

        let handled = false;
        await act(async () => { handled = dispatchEscapeToLayerStack({ key: 'Escape' }); });
        await flushHookEffects({ cycles: 2 });
        expect(handled).toBe(true);
        expect(lifecycle).toEqual(['mount', 'unmount']);

        await act(async () => { handled = dispatchEscapeToLayerStack({ key: 'Escape' }); });
        expect(handled).toBe(false);
    });
});

/**
 * A host that decides which block is open (a nested catalog inside a panel, or a page that opens a
 * block on request): presses are reported, and the grid follows `openId`.
 */
async function renderControlledGrid(lifecycle: string[], initial: string | null) {
    const { SetupBlockGrid } = await import('./SetupBlockGrid');
    const changes: Array<string | null> = [];
    let setOpenId: (id: string | null) => void = () => {};
    function Host() {
        const [openId, set] = React.useState<string | null>(initial);
        setOpenId = set;
        return (
            <SetupBlockGrid
                testID="morph"
                openId={openId}
                onOpenChange={(id) => {
                    changes.push(id);
                    set(id);
                }}
                items={['claude', 'chatgpt'].map((id) => ({
                    id,
                    renderTile: ({ open }: Readonly<{ open: () => void }>) => (
                        <Pressable testID={`tile.${id}.action`} onPress={open}><Text>{id}</Text></Pressable>
                    ),
                    renderPanel: ({ close }: Readonly<{ close: () => void }>) => (
                        <View testID={`panel.${id}`}>
                            <ProbePanel close={close} lifecycle={lifecycle} />
                        </View>
                    ),
                }))}
            />
        );
    }
    const screen = await renderScreen(<Host />);
    await flushHookEffects({ cycles: 2 });
    return { screen, changes, setOpenId: (id: string | null) => setOpenId(id) };
}

describe('SetupBlockGrid with a host that decides what is open', () => {
    it('opens the block its host names, and reports a press and a close to the host', async () => {
        const lifecycle: string[] = [];
        const { screen, changes, setOpenId } = await renderControlledGrid(lifecycle, null);
        expect(screen.findByTestId('panel.chatgpt')).toBeNull();

        // Asked from outside (a page's "Add account"): the block opens without a press.
        await act(async () => { setOpenId('chatgpt'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('panel.chatgpt')).toBeTruthy();
        expect(isCovered(screen, 'claude')).toBe(true);

        // The panel's own close goes through the host, then the grid runs backwards.
        await act(async () => { screen.pressByTestId('probe-panel.close'); });
        await flushHookEffects({ cycles: 2 });
        expect(changes).toEqual([null]);
        expect(screen.findByTestId('panel.chatgpt')).toBeNull();

        // A press is reported, and the grid opens once the host agrees.
        await act(async () => { screen.pressByTestId('tile.claude.action'); });
        await flushHookEffects({ cycles: 2 });
        expect(changes).toEqual([null, 'claude']);
        expect(screen.findByTestId('panel.claude')).toBeTruthy();
    });

    it('starts open when its host already names a block (a nested panel reached by a request)', async () => {
        const lifecycle: string[] = [];
        const { screen, changes } = await renderControlledGrid(lifecycle, 'claude');
        expect(screen.findByTestId('panel.claude')).toBeTruthy();
        expect(isCovered(screen, 'chatgpt')).toBe(true);
        expect(changes).toEqual([]);

        let handled = false;
        await act(async () => { handled = dispatchEscapeToLayerStack({ key: 'Escape' }); });
        await flushHookEffects({ cycles: 2 });
        expect(handled).toBe(true);
        expect(changes).toEqual([null]);
        expect(screen.findByTestId('panel.claude')).toBeNull();
    });
});

describe('resolveInPlaceMorphTiming', () => {
    it('grows the frame over 240 ms, fades the covered tiles in 120 ms and brings the content in after 80 ms', async () => {
        const { resolveInPlaceMorphTiming } = await import('@/components/ui/motion/motionTokens');
        expect(resolveInPlaceMorphTiming(false)).toEqual({ frameMs: 240, coveredFadeMs: 120, contentDelayMs: 80, contentFadeMs: 160, clockMs: 240 });
    });

    it('swaps immediately with a 120 ms cross-fade under reduced motion', async () => {
        const { resolveInPlaceMorphTiming } = await import('@/components/ui/motion/motionTokens');
        expect(resolveInPlaceMorphTiming(true)).toEqual({ frameMs: 0, coveredFadeMs: 120, contentDelayMs: 0, contentFadeMs: 120, clockMs: 120 });
    });
});

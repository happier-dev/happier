import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DetailsTabHeader } from './DetailsTabHeader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function textOf(node: unknown): string {
    const parts: string[] = [];
    const walk = (value: unknown): void => {
        if (value == null || typeof value === 'boolean') return;
        if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
        if (Array.isArray(value)) { value.forEach(walk); return; }
        const children = (value as { children?: unknown }).children;
        if (Array.isArray(children)) { children.forEach(walk); return; }
        walk((value as { props?: { children?: unknown } }).props?.children);
    };
    walk(node);
    return parts.join(' ');
}

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('DetailsTabHeader', () => {
    it('keeps a long phone title readable and its identity switcher operable', async () => {
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
        const onSwitch = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader title="Key the settings modal by route, not window width" titleControl={<ToolbarButton testID="switch-stash" label="Kept on v0.3" onPress={onSwitch} />} />
            </SurfaceStateSizeProvider>,
        );
        await screen.pressByTestIdAsync('switch-stash');
        expect(onSwitch).toHaveBeenCalledOnce();
        await screen.unmount();
        const title = await renderScreen(<SurfaceStateSizeProvider size="phone"><DetailsTabHeader title="Key the settings modal by route, not window width" /></SurfaceStateSizeProvider>);
        // A long name wraps before it truncates, as a page title does (owner round 2 item 4).
        expect(title.findByTestId('details-tab-header.title')?.props.numberOfLines).toBe(2);
    });
    it('keeps live status beside the facts in the shared band', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(<DetailsTabHeader title="Run" metaLeading={<Text testID="live-status">Waiting for you</Text>} meta={[{ key: 'agent', text: 'Codex' }]} />);
        expect(textOf(screen.findByTestId('live-status'))).toBe('Waiting for you');
        expect(screen.getTextContent()).toContain('Codex');
    });
    it('names the thing in the pane header band and reads its facts in order on the live line', async () => {
        const screen = await renderScreen(
            <DetailsTabHeader
                testID="hdr"
                title="SettingsModal.tsx"
                meta={[
                    { key: 'path', text: 'apps/ui/…/settings/', tone: 'muted', shrink: true },
                    { key: 'status', text: 'Modified' },
                    { key: 'stat', kind: 'diffStat', added: 4, removed: 2 },
                    { key: 'by', text: 'by Claude' },
                ]}
            />,
        );
        expect(textOf(screen.findByTestId('hdr.title'))).toBe('SettingsModal.tsx');
        expect(screen.findByTestId('hdr.title')?.props.accessibilityRole).toBe('header');
        const line = textOf(screen.findByTestId('hdr.subtitle'));
        expect(line.indexOf('Modified')).toBeLessThan(line.indexOf('+4'));
        expect(line).toContain('−2');
        expect(line.indexOf('−2')).toBeLessThan(line.indexOf('by Claude'));
    });

    it('runs the surface action it offers, and keeps it on a phone', async () => {
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const onRestore = vi.fn();
        for (const size of ['details', 'phone'] as const) {
            onRestore.mockClear();
            const screen = await renderScreen(
                <SurfaceStateSizeProvider size={size}>
                    <DetailsTabHeader
                        title="Kept on v0.3"
                        buttons={[{ label: 'Restore', tone: 'primary', onPress: onRestore, testID: 'restore' }]}
                    />
                </SurfaceStateSizeProvider>,
            );
            await screen.pressByTestIdAsync('restore');
            expect(onRestore).toHaveBeenCalledTimes(1);
            await screen.unmount();
        }
    });

    it('folds a phone header\'s quiet buttons into `⋯` when they would sit alone on a row beneath the band', async () => {
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const onStage = vi.fn();
        const stage = { label: 'Add to commit', onPress: onStage, testID: 'stage' };
        const shown = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.findAll((node) => node.props.testID === 'stage' && node.props.label !== undefined).length > 0;
        // The phone File page reading a changed file: its view controls live in the bottom toolbar, so the
        // header's one quiet file action would otherwise take a row of its own (lab FV1p has none).
        const alone = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader testID="hdr" title="retry.ts" buttons={[stage]}
                    menuActions={[{ id: 'copy', title: 'Copy path', onSelect: () => {} }]} />
            </SurfaceStateSizeProvider>,
        );
        expect(shown(alone)).toBe(false);
        const menu = alone.findAllByType(PageHeaderMenu)[0]!;
        expect(menu.props.actions.map((action: { testID?: string; id: string }) => action.testID ?? action.id)).toEqual(['stage', 'copy']);
        await menu.props.actions[0].onSelect();
        expect(onStage).toHaveBeenCalledTimes(1);
        await alone.unmount();
        // Beside view controls the same button keeps its place on the row.
        const { Text } = await import('@/components/ui/text/Text');
        const withControls = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader testID="hdr" title="retry.ts" buttons={[stage]} controls={<Text testID="ctl">View | Changes</Text>} />
            </SurfaceStateSizeProvider>,
        );
        expect(shown(withControls)).toBe(true);
        await withControls.unmount();
    });

    it('keeps a phone header in one band when its quiet toggles are all it carries', async () => {
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { Text } = await import('@/components/ui/text/Text');
        const iconsInBand = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === 'people').length ?? 0) > 0;
        const alone = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader testID="hdr" title="Retry cap during deploys" actions={<Text testID="people">people</Text>}
                    menuActions={[{ id: 'rename', title: 'Rename', onSelect: () => {} }]} />
            </SurfaceStateSizeProvider>,
        );
        expect(iconsInBand(alone)).toBe(true);
        await alone.unmount();
        // With view controls the toggles still share the row beneath with them.
        const withControls = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader testID="hdr" title="SettingsModal.tsx" actions={<Text testID="people">people</Text>}
                    controls={<Text testID="ctl">Diff | File</Text>} />
            </SurfaceStateSizeProvider>,
        );
        expect(iconsInBand(withControls)).toBe(false);
        await withControls.unmount();
        // Band controls wider than the room they would leave the name (a view segment, a pill, Find) take the
        // row beneath, so the name is never squeezed to a letter a line (File page editing on a phone).
        const { act } = await import('react-test-renderer');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
        const wide = await renderScreen(
            <SurfaceStateSizeProvider size="phone">
                <DetailsTabHeader testID="hdr" title="README.md" actions={<Text testID="people">Preview | Source · Unsaved · Find</Text>}
                    menuActions={[{ id: 'rename', title: 'Rename', onSelect: () => {} }]} />
            </SurfaceStateSizeProvider>,
        );
        await act(async () => {
            wide.findHostByTestId('hdr.root')!.props.onLayout(layout(390));
            wide.findHostByTestId('hdr.icons')!.props.onLayout(layout(260));
        });
        expect(iconsInBand(wide)).toBe(false);
        await wide.unmount();
    });

    it('moves the view controls beneath the band when they would collide with its actions', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="SettingsModal.tsx" meta={[{ key: 'status', text: 'Modified' }]}
                actions={<Text testID="icons">icons</Text>} controls={<Text testID="ctl">Pending · Diff | File</Text>} />,
        );
        const inBand = () => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === 'ctl').length ?? 0) > 0;
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')!.props.onLayout(layout(300));
                screen.findHostByTestId('hdr.controls')!.props.onLayout(layout(170));
            });
        };
        await measure(1200);
        expect(inBand()).toBe(true);
        // A narrower pane: the chips would paint over the icons, so they take their own row.
        await measure(520);
        expect(inBand()).toBe(false);
        expect(screen.findByTestId('ctl')).not.toBeNull();
        expect(screen.findByTestId('icons')).not.toBeNull();
    });

    it('keeps the title readable by moving wide actions beneath it in a narrow pane', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="SettingsModal.tsx" actions={<Text testID="icons">icons</Text>} />,
        );
        const inBand = () => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === 'icons').length ?? 0) > 0;
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')!.props.onLayout(layout(300));
            });
        };
        await measure(1200);
        expect(inBand()).toBe(true);
        // The icons would leave the file name a few letters ("d."): they take the row beneath the title.
        await measure(420);
        expect(inBand()).toBe(false);
        expect(screen.findByTestId('icons')).not.toBeNull();
        await measure(1200);
        expect(inBand()).toBe(true);
    });

    it('leaves the actions beside a short name that keeps its whole width, and moves them for a long one', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="retry.ts" actions={<Text testID="icons">icons</Text>} />,
        );
        const inBand = () => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === 'icons').length ?? 0) > 0;
        const measure = async (titleWidth: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(520));
                screen.findHostByTestId('hdr.icons')!.props.onLayout(layout(300));
                screen.findHostByTestId('hdr.titleMeasure')!.props.onLayout(layout(titleWidth));
            });
        };
        // The actions take more than half the band, but "retry.ts" still reads whole beside them (lab ED1).
        await measure(90);
        expect(inBand()).toBe(true);
        // A name that would be cut keeps the old rule: the actions take the row beneath.
        await measure(260);
        expect(inBand()).toBe(false);
    });

    it('counts the room taken by `⋯` and the pane controls before leaving the actions beside the title', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="Initial note store" actions={<Text testID="icons">icons</Text>}
                menuActions={[{ id: 'copy', title: 'Copy', onSelect: () => {} }]} />,
        );
        const inBand = () => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === 'icons').length ?? 0) > 0;
        await act(async () => {
            screen.findHostByTestId('hdr.root')!.props.onLayout(layout(420));
            screen.findHostByTestId('hdr.icons')!.props.onLayout(layout(150));
            screen.findHostByTestId('hdr.trailing')!.props.onLayout(layout(130));
        });
        // Beside the title the icons would leave it the 100px left after the menu: it moves them beneath.
        expect(inBand()).toBe(false);
    });

    it('holds the view controls and actions on one row beneath the band, folding the quieter buttons into its menu', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } });
        const onRaw = vi.fn();
        const buttons = [
            { label: 'Raw', onPress: onRaw, testID: 'raw' },
            { label: 'Copy', onPress: () => {}, testID: 'copy' },
            { label: 'Select lines', onPress: () => {}, testID: 'select' },
            { label: 'Add to commit', onPress: () => {}, testID: 'stage' },
        ];
        const widths: Record<string, number> = { raw: 50, copy: 56, select: 90, stage: 110 };
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="" meta={[{ key: 'status', text: 'Modified' }]} buttons={buttons}
                actions={<Text testID="icons">icons</Text>} controls={<Text testID="ctl">Pending · Diff | File</Text>} />,
        );
        const shown = (id: string) => screen.findAll((node) => node.props.testID === id && node.props.label !== undefined).length > 0;
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')!.props.onLayout(layout(128));
                screen.findHostByTestId('hdr.controls')!.props.onLayout(layout(230));
                for (const button of buttons) {
                    const host = screen.findAll((node) => node.props.testID === button.testID && node.props.label !== undefined)[0];
                    host?.parent?.props.onLayout?.(layout(widths[button.testID]!));
                }
            });
        };
        await measure(1400);
        expect(buttons.every((button) => shown(button.testID))).toBe(true);
        expect(screen.findHostByTestId('hdr.menu.trigger')).toBeNull();
        // A ~540px centre pane: controls, toggles and the one file action share a row; the rest wait in `⋯`.
        await measure(540);
        expect(shown('stage')).toBe(true);
        expect(['raw', 'copy', 'select'].some(shown)).toBe(false);
        const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const menu = screen.findAllByType(PageHeaderMenu)[0]!;
        expect(menu.props.actions.map((action: { testID?: string }) => action.testID)).toEqual(['raw', 'copy', 'select']);
        await act(async () => { await menu.props.actions[0].onSelect(); });
        expect(onRaw).toHaveBeenCalledTimes(1);
        // Room again: every button returns to the row.
        await measure(1400);
        expect(buttons.every((button) => shown(button.testID))).toBe(true);
    });

    it('folds the quiet toggles into `⋯` too when the folded buttons still leave the row too narrow', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } });
        const buttons = [
            { label: 'Raw', onPress: () => {}, testID: 'raw' },
            { label: 'Add to commit', onPress: () => {}, testID: 'stage' },
        ];
        const widths: Record<string, number> = { raw: 50, stage: 106 };
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="" meta={[{ key: 'status', text: 'Modified' }]} buttons={buttons}
                actions={<Text testID="icons">icons</Text>} controls={<Text testID="ctl">Pending · Diff | File</Text>} />,
        );
        const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const iconsInRow = () => screen.findAll((node) => node.props.testID === 'icons').some((node) => {
            for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === PageHeaderMenu) return false;
            return true;
        });
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')?.props.onLayout(layout(126));
                screen.findHostByTestId('hdr.controls')!.props.onLayout(layout(231));
                for (const button of buttons) {
                    const host = screen.findAll((node) => node.props.testID === button.testID && node.props.label !== undefined)[0];
                    host?.parent?.props.onLayout?.(layout(widths[button.testID]!));
                }
            });
        };
        await measure(540);
        expect(iconsInRow()).toBe(true);
        // The ~470px file column beside an open commit: the toggles join `⋯`, the file action keeps the row.
        await measure(470);
        expect(iconsInRow()).toBe(false);
        const menu = screen.findAllByType(PageHeaderMenu)[0]!;
        expect(menu.props.content).toBeTruthy();
        expect(screen.findAll((node) => node.props.testID === 'stage' && node.props.label !== undefined).length).toBeGreaterThan(0);
        await measure(540);
        expect(iconsInRow()).toBe(true);
    });

    it('keeps the file action beside the title when it and the view controls would not share a row, folding the rest into `⋯`', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } });
        const buttons = [
            { label: 'Raw', onPress: () => {}, testID: 'raw' },
            { label: 'Copy', onPress: () => {}, testID: 'copy' },
            { label: 'Add to commit', onPress: () => {}, testID: 'stage' },
        ];
        const widths: Record<string, number> = { raw: 47, copy: 52, stage: 106 };
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="README.md" meta={[{ key: 'status', text: 'Modified' }]} buttons={buttons}
                menuActions={[{ id: 'edit', title: 'Edit', onSelect: () => {} }]}
                actions={<Text testID="icons">icons</Text>} controls={<Text testID="ctl">Pending · Diff | File</Text>} />,
        );
        const inBand = (id: string) => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === id).length ?? 0) > 0;
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')?.props.onLayout(layout(282));
                screen.findHostByTestId('hdr.controls')!.props.onLayout(layout(298));
                screen.findHostByTestId('hdr.trailing')!.props.onLayout(layout(96));
                for (const button of buttons) {
                    const host = screen.findAll((node) => node.props.testID === button.testID && node.props.label !== undefined)[0];
                    host?.parent?.props.onLayout?.(layout(widths[button.testID]!));
                }
            });
        };
        await measure(1400);
        expect(buttons.every((button) => inBand(button.testID))).toBe(true);
        expect(inBand('icons')).toBe(true);
        // A ~360px drawer: the controls (298) and even the one button that stays (106) cannot share a row, and a
        // button alone on a second row reads as an afterthought. It stays by the title; the rest wait in `⋯`.
        await measure(360);
        expect(inBand('stage')).toBe(true);
        expect(inBand('raw') || inBand('copy')).toBe(false);
        expect(inBand('ctl')).toBe(false);
        const menu = screen.findAllByType(PageHeaderMenu)[0]!;
        expect(menu.props.content).toBeTruthy();
        expect(menu.props.actions.map((action: { testID?: string }) => action.testID).filter(Boolean)).toEqual(['raw', 'copy']);
        await measure(1400);
        expect(buttons.every((button) => inBand(button.testID))).toBe(true);
        expect(inBand('icons')).toBe(true);
    });

    it('keeps the facts line whole beside the actions by folding a quiet button into `⋯` first (lab FV1c)', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } });
        const buttons = [
            { label: 'Add to commit', onPress: () => {}, testID: 'stage' },
            { label: 'Edit', onPress: () => {}, testID: 'edit' },
        ];
        const widths: Record<string, number> = { stage: 100, edit: 62 };
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="retry.ts"
                meta={[{ key: 'dir', text: 'src' }, { key: 'status', text: 'Modified' }, { key: 'counts', text: '+9 −3' }]}
                buttons={buttons} menuActions={[{ id: 'copy', title: 'Copy path', onSelect: () => {} }]}
                actions={<Text testID="icons">icons</Text>} controls={<Text testID="ctl">View | Changes</Text>} />,
        );
        const inBand = (id: string) => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === id).length ?? 0) > 0;
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')?.props.onLayout(layout(92));
                screen.findHostByTestId('hdr.controls')!.props.onLayout(layout(125));
                screen.findHostByTestId('hdr.trailing')!.props.onLayout(layout(64));
                screen.findHostByTestId('hdr.titleMeasure')!.props.onLayout(layout(90));
                screen.findHostByTestId('hdr.lineMeasure')?.props.onLayout(layout(150));
                for (const button of buttons) {
                    const host = screen.findAll((node) => node.props.testID === button.testID && node.props.label !== undefined)[0];
                    host?.parent?.props.onLayout?.(layout(widths[button.testID]!));
                }
            });
        };
        // A wide pane holds everything on the band and the whole line.
        await measure(1100);
        expect(inBand('stage') && inBand('edit') && inBand('icons') && inBand('ctl')).toBe(true);
        // The ~600 px Changes pane: all of it beside the name would cut "+9 −3" off the line, so the quiet
        // "Add to commit" waits in `⋯`; the file's own Edit, the toggles and the view controls keep their place.
        await measure(600);
        expect(inBand('stage')).toBe(false);
        expect(inBand('edit') && inBand('icons') && inBand('ctl')).toBe(true);
        const menu = screen.findAllByType(PageHeaderMenu)[0]!;
        expect(menu.props.actions.map((action: { testID?: string }) => action.testID).filter(Boolean)).toEqual(['stage']);
    });

    it('gives the actions the row beneath when even the ones that never fold would cut the facts line (Edit, H-T3)', async () => {
        const { act } = await import('react-test-renderer');
        const { Text } = await import('@/components/ui/text/Text');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } } });
        // Editing in the ~600 px drawer: View | Changes, the Editing pill and Find, then the file's one Done.
        const buttons = [{ label: 'Done', onPress: () => {}, testID: 'done' }];
        const screen = await renderScreen(
            <DetailsTabHeader testID="hdr" title="retry.ts"
                meta={[{ key: 'dir', text: 'src' }, { key: 'status', text: 'Modified' }, { key: 'counts', text: '+9 −3' },
                    { key: 'problems', text: '9 problems' }]}
                buttons={buttons} menuActions={[{ id: 'copy', title: 'Copy path', onSelect: () => {} }]}
                actions={<Text testID="icons">View | Changes · Editing · Find</Text>} />,
        );
        const inBand = (id: string) => (screen.findHostByTestId('hdr')?.findAll((node) => node.props.testID === id).length ?? 0) > 0;
        const shown = (id: string) => screen.findAll((node) => node.props.testID === id).length > 0;
        const measure = async (root: number) => {
            await act(async () => {
                screen.findHostByTestId('hdr.root')!.props.onLayout(layout(root));
                screen.findHostByTestId('hdr.icons')?.props.onLayout(layout(300));
                screen.findHostByTestId('hdr.trailing')?.props.onLayout(layout(64));
                screen.findHostByTestId('hdr.titleMeasure')!.props.onLayout(layout(90));
                screen.findHostByTestId('hdr.lineMeasure')?.props.onLayout(layout(240));
                const host = screen.findAll((node) => node.props.testID === 'done' && node.props.label !== undefined)[0];
                host?.parent?.props.onLayout?.(layout(58));
            });
        };
        // A wide pane: name, whole line and every control on the band.
        await measure(1100);
        expect(inBand('icons') && inBand('done')).toBe(true);
        // The drawer: nothing beside the name can fold (Done is the file's action), so the controls move to the
        // row beneath, whole, and the facts line ("· 9 problems") keeps the band instead of being cut.
        await measure(600);
        expect(inBand('icons') || inBand('done')).toBe(false);
        expect(shown('icons') && shown('done')).toBe(true);
    });

    it('does not offer a busy action again', async () => {
        const onSave = vi.fn();
        const screen = await renderScreen(
            <DetailsTabHeader title="useSettingsRouteKey.ts" buttons={[{ label: 'Save', tone: 'primary', busy: true, onPress: onSave, testID: 'save' }]} />,
        );
        const save = screen.findHostByTestId('save');
        expect(save?.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
        await screen.pressByTestIdAsync('save');
        expect(onSave).not.toHaveBeenCalled();
    });
});

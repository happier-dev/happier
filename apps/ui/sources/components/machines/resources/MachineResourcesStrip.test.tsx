import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, createMachineFixture, type RenderScreenResult } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from '@/components/sessions/shell/sessionShellTestHelpers';
import { lightTheme } from '@/theme';
import type { MachineResourcesSnapshot } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineResourcesGetMock = vi.hoisted(() => vi.fn());
const renameMachineWithPromptMock = vi.hoisted(() => vi.fn());
let machinesFixture: ReturnType<typeof createMachineFixture>[] = [];
let featureEnabledValue = true;

installSessionShellCommonModuleMocks({
    featureEnabled: () => ({ useFeatureEnabled: (featureId: string) => featureEnabledValue && featureId === 'machines.resources' }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                if (key === 'status.online') return 'Online';
                if (key === 'status.offline') return 'Offline';
                if (key === 'machine.resources.cpu') return 'CPU';
                if (key === 'machine.resources.memory') return 'Memory';
                if (key === 'machine.resources.disk') return 'Disk';
                return key;
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({ useAllMachines: () => machinesFixture });
    },
});

vi.mock('@/sync/ops/machineResources', () => ({
    machineResourcesGet: machineResourcesGetMock,
}));

vi.mock('@/components/machines/renameMachineWithPrompt', () => ({
    renameMachineWithPrompt: renameMachineWithPromptMock,
}));

// The anchored Popover is a boundary here; stub it so the test asserts the strip seam: chip
// presence, density forms, presence colors, and the popover content contract (gauges, rename,
// refresh on open).
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: Record<string, any>) =>
        props.open
            ? React.createElement('Popover', props, props.children({ maxHeight: 300, maxWidth: 340, placement: 'bottom' }))
            : null,
}));

const { MachineResourcesStrip } = await import('./MachineResourcesStrip');

function createMachine(id: string, input: Readonly<{ online: boolean; host: string; displayName?: string }>) {
    return createMachineFixture({
        id,
        active: input.online,
        activeAt: input.online ? Date.now() : 0,
        metadata: {
            host: input.host,
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
            ...(input.displayName ? { displayName: input.displayName } : {}),
        },
    });
}

function snapshot(input: Readonly<{ cpu: number; memory?: number; disk?: number }>): MachineResourcesSnapshot {
    return {
        sampledAt: 1_700_000_000_000,
        cpu: { usagePercent: input.cpu },
        memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 5.2 * 1024 ** 3, usagePercent: input.memory ?? input.cpu },
        disk: {
            path: '/',
            totalBytes: 16 * 1024 ** 3,
            availableBytes: 8 * 1024 ** 3,
            usedBytes: 8 * 1024 ** 3,
            usagePercent: input.disk ?? input.cpu,
        },
    };
}

function readStyleKey(node: { props: { style?: unknown } }, key: string): unknown {
    const style = node.props.style;
    const entries = Array.isArray(style) ? style : [style];
    for (const entry of entries) {
        if (entry && typeof entry === 'object' && key in (entry as Record<string, unknown>)) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}

function readTextChildren(node: { findAll: (predicate: (item: any) => boolean) => any[] }): string[] {
    const values = node
        .findAll((child) => typeof child.props?.children === 'string' || typeof child.props?.children === 'number')
        .map((child) => String(child.props.children));
    // The RN web mock nests Text several levels deep, repeating the same string per level.
    return [...new Set(values)];
}

/** Ink of the first color-styled Text descendant inside the glyph — the initial on the screen. */
function readGlyphLetterColor(node: { findAll: (predicate: (item: any) => boolean) => any[] }): unknown {
    const letter = node.findAll((child) => readStyleKey(child, 'color') !== undefined);
    const color = letter.length > 0 ? readStyleKey(letter[0], 'color') : undefined;
    return typeof color === 'string' ? color.toLowerCase() : color;
}

/** Ink of the first color-styled Text inside a gauge — the percent number in the ring. */
function readGaugePercentColor(screen: RenderScreenResult, gaugeTestID: string): unknown {
    const gauge = screen.findByTestId(gaugeTestID)!;
    const colored = gauge.findAll((child: { props: { style?: unknown } }) => readStyleKey(child, 'color') !== undefined);
    const color = colored.length > 0 ? readStyleKey(colored[0], 'color') : undefined;
    return typeof color === 'string' ? color.toLowerCase() : color;
}

async function renderStrip(): Promise<RenderScreenResult> {
    let screen: RenderScreenResult | null = null;
    await act(async () => {
        screen = await renderScreen(<MachineResourcesStrip />);
    });
    if (screen === null) throw new Error('MachineResourcesStrip test renderer did not mount');
    return screen;
}

async function layoutStrip(screen: RenderScreenResult, width: number): Promise<void> {
    const row = screen.findHostByTestId('machine-resources-strip');
    const handleLayout = row?.props.onLayout;
    if (typeof handleLayout !== 'function') throw new Error('machine-resources-strip row has no onLayout handler');
    await act(async () => {
        handleLayout({ nativeEvent: { layout: { width } } });
    });
}

describe('MachineResourcesStrip', () => {
    beforeEach(() => {
        featureEnabledValue = true;
        renameMachineWithPromptMock.mockReset();
        renameMachineWithPromptMock.mockResolvedValue('renamed');
    });
    afterEach(() => {
        standardCleanup();
        machineResourcesGetMock.mockReset();
        machinesFixture = [];
        featureEnabledValue = true;
    });

    it('renders one comfort chip per machine with monitor glyphs, aliases, and presence borders', async () => {
        machinesFixture = [
            createMachine('strip-a', { online: true, host: 'mac-studio.local' }),
            createMachine('strip-b', { online: true, host: 'jd-cloud.local', displayName: '京东云' }),
            createMachine('strip-off', { online: false, host: 'old-laptop.local' }),
        ];
        machineResourcesGetMock.mockImplementation(async (machineId: string) =>
            machineId === 'strip-a'
                ? { ok: true, snapshot: snapshot({ cpu: 95, memory: 20, disk: 30 }) }
                : machineId === 'strip-b'
                    ? { ok: true, snapshot: snapshot({ cpu: 10 }) }
                    : { ok: false, error: 'offline' },
        );

        const screen = await renderStrip();

        expect(screen.findByTestId('machine-resources-strip')).toBeTruthy();
        expect(screen.findByTestId('machine-resources-chip:strip-a')).toBeTruthy();
        expect(screen.findByTestId('machine-resources-chip:strip-b')).toBeTruthy();
        expect(screen.findByTestId('machine-resources-chip:strip-off')).toBeTruthy();

        // Comfort chips show the monitor glyph's initial plus the alias; CJK initials pass through.
        expect(readTextChildren(screen.findByTestId('machine-resources-chip:strip-a-glyph')!)).toEqual(['M']);
        // strip-a only breaches on CPU, so its chip corner carries a single danger cpu icon badge.
        const alertsView = screen.findByTestId('machine-resources-chip:strip-a-alerts')!;
        const badgeIcon = alertsView.findAll((child: { props: { color?: unknown } }) => typeof child.props?.color === 'string')[0];
        expect(badgeIcon?.props.name).toBe('cpu');
        expect(badgeIcon?.props.color).toBe(lightTheme.colors.state.danger.foreground);
        // A healthy machine (strip-b, all metrics low) carries no alert badges at all.
        expect(screen.findAllByTestId('machine-resources-chip:strip-b-alerts')).toHaveLength(0);
        expect(readTextChildren(screen.findByTestId('machine-resources-chip:strip-b-glyph')!)).toEqual(['京']);
        expect(screen.findByTestId('machine-resources-chip:strip-a-alias')?.props.children).toBe('mac-studio.local');
        expect(screen.findByTestId('machine-resources-chip:strip-b-alias')?.props.children).toBe('京东云');
        // The letter sits on the canvas surface, so it uses the primary ink, not a state ink.
        expect(readGlyphLetterColor(screen.findByTestId('machine-resources-chip:strip-a-glyph')!))
            .toBe(lightTheme.colors.text.primary.toLowerCase());

        // Quiet-normal calibration: every chip wears the same neutral hairline border with no
        // tint fill, healthy or not — the corner alert badges carry all the color signal.
        for (const chipId of ['strip-a', 'strip-b', 'strip-off']) {
            expect(readStyleKey(screen.findByTestId(`machine-resources-chip:${chipId}`)!, 'borderColor'))
                .toBe(lightTheme.colors.border.surface);
            expect(readStyleKey(screen.findByTestId(`machine-resources-chip:${chipId}`)!, 'backgroundColor'))
                .toBe(undefined);
        }

        // Multi-machine rows distribute their chips evenly instead of left-packing them.
        expect(readStyleKey(screen.findHostByTestId('machine-resources-strip')!, 'justifyContent'))
            .toBe('space-evenly');

        expect(screen.findByTestId('machine-resources-chip:strip-a')?.props.accessibilityLabel)
            .toBe('mac-studio.local, Online');
        expect(screen.findByTestId('machine-resources-chip:strip-off')?.props.accessibilityLabel)
            .toBe('old-laptop.local, Offline');
        expect(machineResourcesGetMock).not.toHaveBeenCalledWith('strip-off', expect.anything());
    });

    it('grows comfort chips equally to fill the row and ellipsizes long aliases in place', async () => {
        machinesFixture = [
            createMachine('strip-ellip', { online: true, host: 'mac-studio-ultra.local' }),
            createMachine('strip-ellip-b', { online: true, host: 'jd' }),
        ];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 42 }) });

        const screen = await renderStrip();
        // 160px measured row: both machines stay in comfort no matter how long or short the
        // alias is — the chips share the row equally instead of packing to the left.
        await layoutStrip(screen, 160);

        const longChip = screen.findByTestId('machine-resources-chip:strip-ellip')!;
        const shortChip = screen.findByTestId('machine-resources-chip:strip-ellip-b')!;
        expect(readStyleKey(longChip, 'flexGrow')).toBe(1);
        expect(readStyleKey(longChip, 'flexBasis')).toBe(0);
        expect(readStyleKey(shortChip, 'flexGrow')).toBe(1);
        expect(readStyleKey(shortChip, 'flexBasis')).toBe(0);

        // Long names truncate inside the chip's share; short names are not clipped by a budget.
        const alias = screen.findByTestId('machine-resources-chip:strip-ellip-alias');
        expect(alias?.props.ellipsizeMode).toBe('tail');
        expect(readStyleKey(alias!, 'maxWidth')).toBe(undefined);
        expect(screen.findByTestId('machine-resources-chip:strip-ellip-b-alias')?.props.children).toBe('jd');
    });

    it('collapses a ten-machine row to glyph-only chips inside a wrapping row', async () => {
        machinesFixture = Array.from({ length: 10 }, (_, index) =>
            createMachine(`fleet-${index}`, { online: true, host: `fleet-machine-${index}.local` }));
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 42 }) });

        const screen = await renderStrip();
        await layoutStrip(screen, 220);

        expect(screen.findByTestId('machine-resources-chip:fleet-0-glyph')).toBeTruthy();
        expect(screen.findAllByTestId('machine-resources-chip:fleet-0-alias')).toHaveLength(0);
        // Glyph rows wrap instead of overflowing once even glyph-only chips cannot fit a line.
        expect(readStyleKey(screen.findHostByTestId('machine-resources-strip')!, 'flexWrap')).toBe('wrap');
    });

    it('keeps an online-but-unsampled machine neutral gray', async () => {
        machinesFixture = [createMachine('strip-unknown', { online: true, host: 'fresh.local' })];
        machineResourcesGetMock.mockResolvedValue({ ok: false, error: 'unsupported' });

        const screen = await renderStrip();

        // A single machine renders inline metrics; the unsampled tone keeps the neutral ink.
        expect(readGlyphLetterColor(screen.findByTestId('machine-resources-chip:strip-unknown-glyph')!))
            .toBe(lightTheme.colors.text.primary.toLowerCase());
        expect(readTextChildren(screen.findByTestId('machine-resources-chip:strip-unknown-glyph')!)).toEqual(['F']);
    });

    it('collapses to glyph-only chips when even minimal aliases cannot fit', async () => {
        machinesFixture = [
            createMachine('wide-a', { online: true, host: 'mac-studio-ultra.local' }),
            createMachine('wide-b', { online: true, host: 'jd-cloud-compute.local' }),
            createMachine('wide-c', { online: true, host: 'old-laptop-drawer.local' }),
        ];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 42 }) });

        const screen = await renderStrip();
        await layoutStrip(screen, 60);

        expect(screen.findByTestId('machine-resources-chip:wide-a-glyph')).toBeTruthy();
        expect(screen.findAllByTestId('machine-resources-chip:wide-a-alias')).toHaveLength(0);
        expect(screen.findAllByTestId('machine-resources-chip:wide-b-alias')).toHaveLength(0);
    });

    it('inlines the three metrics for a single machine', async () => {
        machinesFixture = [createMachine('strip-solo', { online: true, host: 'mac-studio.local' })];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 42, memory: 33, disk: 61 }) });

        const screen = await renderStrip();

        expect(screen.findByTestId('machine-resources-chip:strip-solo-metrics')?.props.children)
            .toBe('CPU 42% · Memory 5.2/16 GB · Disk 61%');
        expect(readTextChildren(screen.findByTestId('machine-resources-chip:strip-solo-glyph')!)).toEqual(['M']);
        expect(screen.findAllByTestId('machine-resources-chip:strip-solo-alias')).toHaveLength(0);
    });

    it('renders placeholder metrics for a single machine without a sample yet', async () => {
        machinesFixture = [createMachine('strip-solo-off', { online: false, host: 'old-laptop.local' })];
        machineResourcesGetMock.mockResolvedValue({ ok: false, error: 'offline' });

        const screen = await renderStrip();

        expect(screen.findByTestId('machine-resources-chip:strip-solo-off-metrics')?.props.children)
            .toBe('CPU — · Memory — · Disk —');
    });

    it('opens the detail popover on a solid themed surface with the three gauges and forces one extra sample', async () => {
        machinesFixture = [createMachine('strip-pop', { online: true, host: 'mac-studio.local' })];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 95, memory: 30, disk: 30 }) });

        const screen = await renderStrip();
        const initialCalls = machineResourcesGetMock.mock.calls.length;

        await act(async () => {
            screen.pressByTestId('machine-resources-chip:strip-pop');
        });

        expect(machineResourcesGetMock.mock.calls.length).toBe(initialCalls + 1);
        // The popover content owns an opaque themed surface so the session list never reads
        // through it.
        expect(readStyleKey(screen.findByTestId('machine-resources-chip:strip-pop-popover')!, 'backgroundColor'))
            .toBe(lightTheme.colors.surface.base);
        expect(screen.findByTestId('machine-resources-chip:strip-pop-label-cpu')?.props.children).toBe('CPU');
        expect(screen.findByTestId('machine-resources-chip:strip-pop-label-memory')?.props.children).toBe('Memory');
        expect(screen.findByTestId('machine-resources-chip:strip-pop-label-disk')?.props.children).toBe('Disk');
        // Each gauge speaks for its own metric: cpu breaches (danger ring), memory/disk stay
        // neutral gray — mirroring the corner badges instead of the machine-wide worst tone.
        expect(readGaugePercentColor(screen, 'machine-resources-chip:strip-pop-gauge-cpu'))
            .toBe(lightTheme.colors.state.danger.foreground.toLowerCase());
        expect(readGaugePercentColor(screen, 'machine-resources-chip:strip-pop-gauge-memory'))
            .toBe(lightTheme.colors.text.secondary.toLowerCase());
        expect(readGaugePercentColor(screen, 'machine-resources-chip:strip-pop-gauge-disk'))
            .toBe(lightTheme.colors.text.secondary.toLowerCase());
    });

    it('keeps the popover open while the pointer bridges from the chip onto it', async () => {
        machinesFixture = [createMachine('strip-hover', { online: true, host: 'mac-studio.local' })];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 42 }) });

        const screen = await renderStrip();
        vi.useFakeTimers();
        try {
            const chip = screen.findByTestId('machine-resources-chip:strip-hover')!;
            await act(async () => {
                chip.props.onHoverIn?.();
            });
            expect(screen.findByTestId('machine-resources-chip:strip-hover-popover')).toBeTruthy();

            // Leaving the chip starts a grace-period close, not an immediate one.
            await act(async () => {
                chip.props.onHoverOut?.();
            });
            expect(screen.findByTestId('machine-resources-chip:strip-hover-popover')).toBeTruthy();

            // Entering the popover cancels the pending close entirely.
            await act(async () => {
                screen.findByTestId('machine-resources-chip:strip-hover-popover')!.props.onMouseEnter?.();
            });
            await act(async () => {
                vi.advanceTimersByTime(600);
            });
            expect(screen.findByTestId('machine-resources-chip:strip-hover-popover')).toBeTruthy();

            // Leaving the popover closes after the grace period elapses.
            await act(async () => {
                screen.findByTestId('machine-resources-chip:strip-hover-popover')!.props.onMouseLeave?.();
            });
            await act(async () => {
                vi.advanceTimersByTime(600);
            });
            expect(screen.findAllByTestId('machine-resources-chip:strip-hover-popover')).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs the shared rename flow from the popover header', async () => {
        machinesFixture = [createMachine('strip-rename', { online: true, host: 'mac-studio.local', displayName: 'Studio' })];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 20 }) });

        const screen = await renderStrip();
        await act(async () => {
            screen.pressByTestId('machine-resources-chip:strip-rename');
        });

        expect(screen.findByTestId('machine-resources-chip:strip-rename-rename')).toBeTruthy();
        await act(async () => {
            screen.pressByTestId('machine-resources-chip:strip-rename-rename');
        });

        expect(renameMachineWithPromptMock).toHaveBeenCalledTimes(1);
        expect(renameMachineWithPromptMock.mock.calls[0][0]?.id).toBe('strip-rename');
    });

    it('renders nothing while the feature flag is disabled', async () => {
        featureEnabledValue = false;
        machinesFixture = [createMachine('strip-gated', { online: true, host: 'gated.local' })];
        machineResourcesGetMock.mockResolvedValue({ ok: true, snapshot: snapshot({ cpu: 1 }) });

        const screen = await renderStrip();

        expect(screen.findAllByTestId('machine-resources-strip')).toHaveLength(0);
        expect(machineResourcesGetMock).not.toHaveBeenCalled();
    });
});

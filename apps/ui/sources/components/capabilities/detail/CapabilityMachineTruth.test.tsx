import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilityMachineTruth } from './CapabilityMachineTruth';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => {
    standardCleanup();
});

const ROWS = [
    { machineId: 'mbp', machineName: 'MacBook Pro', deviceIcon: 'laptop' as const, os: 'macOS', who: '41 tools · checked 10:31' },
    { machineId: 'nl2', machineName: 'nl2', deviceIcon: 'desktop' as const, who: 'Could not start', status: { kind: 'error' as const, machineName: 'nl2' } },
    { machineId: 'win', machineName: 'Windows desktop', deviceIcon: 'desktop' as const, who: '41 tools', offline: true,
        status: { kind: 'offline' as const }, note: 'last known Oct 9' },
];

describe('CapabilityMachineTruth', () => {
    it('reads as one summary closed, and one row per machine with its own status once opened', async () => {
        const screen = await renderScreen(
            <CapabilityMachineTruth testID="mt" rows={ROWS} summary="Ready on 1 · stopped on 1 · offline 1" />,
        );
        expect(screen.getTextContent()).toContain('Ready on 1 · stopped on 1 · offline 1');
        expect(screen.findAllByTestId('mt:machine:mbp')).toHaveLength(0);

        await pressTestInstanceAsync(screen.findByTestId('mt:summary'), 'summary');

        expect(screen.findAllByTestId('mt:machine:mbp').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('mt:machine:nl2:status').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('mt:machine:mbp:status')).toHaveLength(0);
        await pressTestInstanceAsync(screen.findByTestId('mt:offline'), 'offline machines');
        expect(screen.findByTestId('mt:machine:win:note')).not.toBeNull();
        expect(screen.getTextContent()).toContain('last known Oct 9');
    });

    it('reads as loading, never as nowhere, while the rules that decide the machines are unread', async () => {
        const screen = await renderScreen(
            <CapabilityMachineTruth testID="mt" rows={[]} summary="" emptyLabel="Not on any machine yet" loading />,
        );
        expect(screen.findAllByTestId('mt:loading').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('Not on any machine yet');
    });

    it('lists every machine at once in list form, and opens one row into its own detail', async () => {
        const opened: Array<string | null> = [];
        const rows = ROWS.map((row) => ({ ...row, detail: <React.Fragment>{`setup for ${row.machineName}`}</React.Fragment> }));
        const Host = () => {
            const [open, setOpen] = React.useState<string | null>(null);
            return (
                <CapabilityMachineTruth
                    testID="mt"
                    presentation="list"
                    rows={rows}
                    summary=""
                    expandedMachineId={open}
                    onExpandedMachineChange={(machineId) => { opened.push(machineId); setOpen(machineId); }}
                />
            );
        };
        const screen = await renderScreen(<Host />);
        expect(screen.findAllByTestId('mt:summary')).toHaveLength(0);
        expect(screen.findAllByTestId('mt:machine:mbp').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('mt:offline').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('setup for nl2');

        await pressTestInstanceAsync(screen.findByTestId('mt:machine:nl2'), 'nl2 row');

        expect(opened).toEqual(['nl2']);
        expect(screen.getTextContent()).not.toContain('setup for MacBook Pro');
    });

    it('says once that machines are offline: they wait behind one "N offline machines" row with their last-known facts', async () => {
        const rows = [
            ...ROWS.map(({ status: _status, ...row }) => row),
            { machineId: 'old', machineName: 'Old laptop', deviceIcon: 'laptop' as const, who: 'Last seen signed in', offline: true },
        ];
        for (const presentation of ['list', 'summary'] as const) {
            const screen = await renderScreen(
                <CapabilityMachineTruth testID="mt" presentation={presentation} rows={rows} summary="Ready on 1" defaultExpanded />,
            );
            expect(screen.findAllByTestId('mt:machine:mbp').length).toBeGreaterThan(0);
            expect(screen.findAllByTestId('mt:offline').length).toBeGreaterThan(0);
            expect(screen.getTextContent().match(/offline/gi)).toHaveLength(1);
            expect(screen.getTextContent()).toContain('2 offline machines');
            expect(screen.findAllByTestId('mt:machine:win')).toHaveLength(0);

            await pressTestInstanceAsync(screen.findByTestId('mt:offline'), 'offline machines');

            expect(screen.findAllByTestId('mt:machine:win').length).toBeGreaterThan(0);
            expect(screen.getTextContent()).toContain('Last seen signed in');
            expect(screen.getTextContent().match(/offline/gi)).toHaveLength(1);
            standardCleanup();
        }
    });

    it('opens the offline machines when there is nothing else to show, or the page opened one of them', async () => {
        const offlineOnly = ROWS.filter((row) => row.offline);
        const alone = await renderScreen(<CapabilityMachineTruth testID="mt" presentation="list" rows={offlineOnly} summary="" />);
        expect(alone.findAllByTestId('mt:machine:win').length).toBeGreaterThan(0);
        expect(alone.findAllByTestId('mt:offline').length).toBeGreaterThan(0);
        standardCleanup();

        const opened = await renderScreen(
            <CapabilityMachineTruth testID="mt" presentation="list" rows={ROWS} summary="" expandedMachineId="win" />,
        );
        expect(opened.findAllByTestId('mt:machine:win').length).toBeGreaterThan(0);
    });

    it('keeps the open machine in view when it would fold behind "more machines"', async () => {
        const rows = [
            ...ROWS,
            { machineId: 'spare', machineName: 'Spare', deviceIcon: 'desktop' as const, who: 'Not installed' },
        ].map((row) => ({ ...row, detail: <React.Fragment>{`setup for ${row.machineName}`}</React.Fragment> }));
        const screen = await renderScreen(
            <CapabilityMachineTruth testID="mt" presentation="list" rows={rows} summary="" visibleCount={1} expandedMachineId="nl2" />,
        );
        // The page that sends someone to a machine ("Set up Codex" on nl2) never hides that machine's row.
        expect(screen.findAllByTestId('mt:machine:nl2').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('mt:machine:spare')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('1 more machine');
    });
});

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { storage } from '@/sync/domains/state/storageStore';
import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
} from '@/components/onboarding/commands/wizardCliCommands';

import { MachineArrivalCard } from './MachineArrivalCard';

afterEach(() => {
    standardCleanup();
});

function normalizeRenderedCodeText(value: string): string {
    return value.replace(/https:\s+\/\//g, 'https://');
}

describe('MachineArrivalCard', () => {
    it('renders instructional mode as command-only handoff without a watching state', async () => {
        const screen = await renderScreen(
            <MachineArrivalCard mode="instructional" serverUrl="https://relay.example.test" />,
            { flushOptions: { cycles: 1, turns: 4 } },
        );

        expect(screen.getTextContent()).toContain("After you sign in, we'll detect it automatically.");
        expect(screen.getTextContent()).not.toContain('Watching for your machine...');
        expect(screen.findAllByType(StatusPill as never)).toHaveLength(0);
        expect(normalizeRenderedCodeText(screen.getTextContent())).toContain(buildCliInstallAndRunCommandForCurrentApp({
            action: 'setup',
            args: ['--relay-url', 'https://relay.example.test', '--yes'],
        }));
    });

    it('wraps the command onto multiple lines so it is fully readable (never faded/cut)', async () => {
        const screen = await renderScreen(
            <MachineArrivalCard mode="instructional" serverUrl="https://relay.example.test" />,
            { flushOptions: { cycles: 1, turns: 4 } },
        );

        // Spec §2 / F-W13-1: the one-command row must show the FULL command —
        // wrapped in-flow, NOT inside a horizontal overflow scroller whose
        // edge fade hides unread content. When CodeBlockView wraps, it renders
        // a plain padded View and the scrollTestID'd scroller never mounts.
        expect(screen.findByTestId('machine-arrival-card-command-setup')).toBeNull();
        expect(normalizeRenderedCodeText(screen.getTextContent())).toContain(buildCliInstallAndRunCommandForCurrentApp({
            action: 'setup',
            args: ['--relay-url', 'https://relay.example.test', '--yes'],
        }));
    });

    it('uses wizardCliCommands builders instead of inlining command strings', () => {
        const sourcePath = fileURLToPath(new URL('./MachineArrivalCard.tsx', import.meta.url));
        const source = fs.readFileSync(sourcePath, 'utf8');

        expect(source).toContain('buildCliInstallAndRunCommandForCurrentApp');
        expect(source).toContain('buildCliInstallAndRunPowershellCommandForCurrentApp');
        expect(source).toContain("from '@/components/ui/status/StatusPill'");
        expect(source).not.toContain('curl -fsSL');
        expect(source).not.toContain('happier setup');
        expect(source).not.toContain('hprev setup');
        expect(source).not.toContain('hdev setup');
    });

    it('renders live mode as watching, then flips to connected and calls onArrived once', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        const onArrived = vi.fn();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));

            const screen = await renderScreen(
                <MachineArrivalCard
                    mode="live"
                    serverUrl="https://relay.example.test"
                    onArrived={onArrived}
                    notSeeingYourMachine={<Text>diagnostic slot</Text>}
                />,
                { flushOptions: { cycles: 2, turns: 4 } },
            );

            expect(screen.getTextContent()).toContain('Watching for your machine...');
            expect(screen.findByTestId('machine-arrival-card-status:variant:neutral')).toBeTruthy();
            expect(screen.findByTestId('machine-arrival-card-details')).not.toBeNull();

            await act(async () => {
                storage.getState().applyMachines([
                    createMachineFixture({
                        id: 'm-live',
                        active: true,
                        activeAt: now,
                        updatedAt: now,
                        metadata: {
                            host: 'workstation',
                            displayName: 'Workstation',
                            platform: 'darwin',
                            happyCliVersion: '0.0.0-test',
                            happyHomeDir: '/Users/tester/.happy-dev',
                            homeDir: '/Users/tester',
                        },
                    }),
                ]);
            });

            expect(screen.getTextContent()).toContain('Connected');
            expect(screen.getTextContent()).toContain('Workstation');
            expect(screen.findByTestId('machine-arrival-card-status:variant:success')).toBeTruthy();
            expect(onArrived).toHaveBeenCalledTimes(1);
            expect(onArrived).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-live' }));

            await act(async () => {
                storage.getState().applyMachines([
                    createMachineFixture({ id: 'm-live', active: true, activeAt: now + 1000, updatedAt: now + 1000 }),
                ]);
            });

            expect(onArrived).toHaveBeenCalledTimes(1);
            await screen.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('renders PowerShell from the wizard command builder when the Windows tab is selected', async () => {
        const screen = await renderScreen(
            <MachineArrivalCard mode="instructional" serverUrl="https://relay.example.test" />,
            { flushOptions: { cycles: 1, turns: 4 } },
        );

        await screen.pressByTestIdAsync('machine-arrival-card-command-setup-platform:windows');

        expect(normalizeRenderedCodeText(screen.getTextContent())).toContain(buildCliInstallAndRunPowershellCommandForCurrentApp({
            action: 'setup',
            args: ['--relay-url', 'https://relay.example.test', '--yes'],
        }));
    });
});

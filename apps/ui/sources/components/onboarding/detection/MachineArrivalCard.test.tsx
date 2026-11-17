import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

// Locale is an environment boundary; these contracts exercise routes/commands, not translation loading.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { storage } from '@/sync/domains/state/storageStore';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { buildMachineAddCommand } from '@/components/machines/add/machineAddCommand';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

import { MachineArrivalCard } from './MachineArrivalCard';

const publicGuestCli = { source: 'public-release', line: '0.3', channel: 'stable' } as const;
let commandHomeId: string;
beforeEach(async () => {
    const home = await upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Command Home' });
    commandHomeId = home.id;
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready',
        features: createRootLayoutFeaturesResponse({ capabilities: { guestCli: publicGuestCli } }) } });
});

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

        expect(screen.findByTestId('machine-arrival-card-status')).toBeNull();
        expect(screen.findAllByType(StatusPill as never)).toHaveLength(0);
        expect(normalizeRenderedCodeText(screen.getTextContent())).toContain(buildMachineAddCommand({
            kind: 'joinHome', os: 'macos', descriptor: null, guestCli: publicGuestCli,
            fallbackHomeUrl: 'https://relay.example.test',
        }));
    });

    it('withdraws copied setup commands when the Home advertises its own payload', async () => {
        const screen = await renderScreen(<MachineArrivalCard mode="instructional" serverUrl="https://relay.example.test" />);
        expect(screen.findByTestId('machine-arrival-card-command-setup')).toBeTruthy();
        await act(async () => primeServerFeaturesSnapshot({ serverId: commandHomeId, snapshot: { status: 'ready',
            features: createRootLayoutFeaturesResponse({ capabilities: {
                guestCli: { source: 'home-payload', line: '0.3', channel: 'publicdev' },
            } }) } }));
        expect(screen.findByTestId('machine-arrival-card-command-setup')).toBeNull();
    });

    it('offers an exported POSIX pin while keeping unsupported Windows unavailable', async () => {
        const screen = await renderScreen(<MachineArrivalCard mode="instructional" serverUrl="https://relay.example.test" />);
        await act(async () => primeServerFeaturesSnapshot({ serverId: commandHomeId, snapshot: { status: 'ready',
            features: createRootLayoutFeaturesResponse({ capabilities: { guestCli: {
                source: 'home-payload', line: '0.3', channel: 'publicdev', payloads: [
                    { target: { os: 'linux', arch: 'x64' }, sha256: '4b'.repeat(32), url: '/v1/runtime/guest-cli/payloads/linux/x64' },
                ],
            } } }) } }));
        expect(screen.findByTestId('machine-arrival-card-command-setup')).toBeTruthy();
        await screen.pressByTestIdAsync('machine-arrival-card-command-setup.os:linux');
        expect(screen.getTextContent()).toContain('4b'.repeat(32));
        await screen.pressByTestIdAsync('machine-arrival-card-command-setup.os:windows');
        const { CodeBlockView } = await import('@/components/ui/code/blocks/CodeBlockView');
        expect(screen.findAllByType(CodeBlockView)).toHaveLength(0);
        expect(screen.findByTestId('machine-arrival-card-command-setup.os:linux')).toBeTruthy();
        await screen.pressByTestIdAsync('machine-arrival-card-command-setup.os:linux');
        expect(screen.getTextContent()).toContain('4b'.repeat(32));
    });

    it('renders live mode as watching, then flips to connected and calls onArrived once', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        const onArrived = vi.fn();
        const home = await upsertServerProfile({ serverUrl: 'https://card-arrival.example.test', name: 'Arrival test Home' });
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));
            // The wait begins from a loaded (empty) machine list.
            storage.getState().applyMachines([], true, { sourceServerId: home.id });

            const screen = await renderScreen(
                <MachineArrivalCard
                    mode="live"
                    serverUrl={home.serverUrl}
                    onArrived={onArrived}
                    notSeeingYourMachine={<Text>diagnostic slot</Text>}
                />,
                { flushOptions: { cycles: 2, turns: 4 } },
            );

            expect(screen.findByTestId('machine-arrival-card-status:variant:neutral')).toBeTruthy();
            expect(screen.getTextContent()).not.toContain('diagnostic slot');
            await screen.pressByTestIdAsync('machine-arrival-card-details-toggle');
            expect(screen.getTextContent()).toContain('diagnostic slot');

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
                ], false, { sourceServerId: home.id });
            });

            expect(screen.getTextContent()).toContain('Workstation');
            expect(screen.findByTestId('machine-arrival-card-status:variant:success')).toBeTruthy();
            expect(onArrived).toHaveBeenCalledTimes(1);
            expect(onArrived).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-live' }));

            await act(async () => {
                storage.getState().applyMachines([
                    createMachineFixture({ id: 'm-live', active: true, activeAt: now + 1000, updatedAt: now + 1000 }),
                ], false, { sourceServerId: home.id });
            });

            expect(onArrived).toHaveBeenCalledTimes(1);
            await screen.unmount();
        } finally {
            storage.setState(previousState);
            await removeServerProfile(home.id);
        }
    });

    it('offers exactly one checked OS choice and switches the copied command to Windows', async () => {
        const screen = await renderScreen(
            <MachineArrivalCard mode="instructional" serverUrl="https://relay.example.test" />,
        );
        const radios = screen.findAllByProps({ accessibilityRole: 'radio' })
            .filter((node) => typeof node.type === 'string');
        expect(radios).toHaveLength(3);
        expect(radios.filter((radio) => radio.props.accessibilityState?.checked)).toHaveLength(1);

        await screen.pressByTestIdAsync('machine-arrival-card-command-setup.os:windows');
        expect(normalizeRenderedCodeText(screen.getTextContent())).toContain(buildMachineAddCommand({
            kind: 'joinHome', os: 'windows', descriptor: null, guestCli: publicGuestCli,
            fallbackHomeUrl: 'https://relay.example.test',
        }));
        expect(screen.findByTestId('machine-arrival-card-command-setup.os:windows')?.props.accessibilityState.checked).toBe(true);

        await screen.pressByTestIdAsync('machine-arrival-card-command-setup.os:linux');
        expect(screen.findByTestId('machine-arrival-card-command-setup.os:windows')?.props.accessibilityState.checked).toBe(false);
        expect(screen.findByTestId('machine-arrival-card-command-setup.os:linux')?.props.accessibilityState.checked).toBe(true);
    });
});

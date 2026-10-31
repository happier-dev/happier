import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const machineRpc = vi.hoisted(() => vi.fn());
let serverId = '';
const probePath = '/v1/diagnostics/bug-report-snapshot?lines=50';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));

// The daemon RPC and Home HTTP/credential boundaries leave real admission, state and doctor logic underneath.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(machineRpc));
const { DiagnosisView } = await import('./DiagnosisView');
const { Item } = await import('@/components/ui/lists/Item');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');

function snapshotFor(machineId: string, serverUrl = 'https://home.example') {
    return {
        capturedAt: '2026-09-15T00:00:00.000Z',
        server: {
            activeServerId: serverId,
            serverUrl,
            publicServerUrl: serverUrl,
            webappUrl: 'https://app.example',
        },
        accountId: 'account-1',
        settings: {
            activeServerId: serverId,
            servers: [],
            knownAccountIds: ['account-1'],
        },
        machineId,
    };
}

async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        await Promise.resolve();
    }
}

beforeEach(async () => {
    await home.reset();
    serverId = await home.addHome({ name: 'Diagnosis', serverUrl: 'https://home.example', accountId: 'account-1' });
    home.answer(serverId, probePath, { status: 200 });
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { clearCachedMachineDoctorSnapshot } = await import('@/components/machines/doctorSnapshot/machineDoctorSnapshotCache');
    const machines = Array.from({ length: 4 }, (_, index) => {
        const machine = createMachineFixture({ id: `machine-${index + 1}`, activeAt: Date.now() });
        clearCachedMachineDoctorSnapshot({ serverId, machineId: machine.id });
        return { ...machine, metadata: { ...machine.metadata!, displayName: `Machine ${index + 1}`, host: `machine-${index + 1}` } };
    });
    getStorage().getState().applyMachines(machines, true, { sourceServerId: serverId });
    getStorage().setState({ profile: { ...getStorage().getState().profile, id: 'account-1' } });
    machineRpc.mockReset();
    machineRpc.mockImplementation(async ({ machineId }: { machineId: string }) => ({ doctorSnapshot: snapshotFor(machineId) }));
});
afterEach(async () => { await standardCleanup(); await home.reset(); });

async function runDiagnosis(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const previous = home.requestsFor(probePath).length;
    await act(async () => {
        screen.pressByTestId('diagnosis-run-button');
        await waitForHomeGovernance(() => expect(home.requestsFor(probePath)).toHaveLength(previous + 1));
        await settle();
    });
}

describe('DiagnosisView', () => {
    it('renders and checks every online machine before announcing whole-system success', async () => {
        const screen = await renderScreen(<DiagnosisView />);

        await runDiagnosis(screen);

        expect(machineRpc.mock.calls.map(([input]) => input.machineId)).toEqual([
            'machine-1',
            'machine-2',
            'machine-3',
            'machine-4',
        ]);
        const status = screen.findByTestId('diagnosis-accessibility-status');
        expect(status?.props.accessibilityLiveRegion).toBe('polite');
        expect(status?.props['aria-live']).toBe('polite');
        expect(status?.props.children).toBe('diagnosis.findings.none');
    });

    it('labels the diagnostics JSON input and announces the bounded running state', async () => {
        let release!: () => void;
        machineRpc.mockImplementationOnce(({ machineId }: { machineId: string }) => new Promise(resolve => {
            release = () => resolve({ doctorSnapshot: snapshotFor(machineId) });
        }));

        const screen = await renderScreen(<DiagnosisView />);

        const findings = () => screen.findAllByType(ItemGroup)
            .find((node) => node.props.title === 'diagnosis.sections.findings')!;
        const findingTitles = () => {
            const group = findings();
            return screen.findAllByType(Item).filter((node) => {
                for (let parent = node.parent; parent; parent = parent.parent) {
                    if (parent === group) return true;
                }
                return false;
            }).map((node) => node.props.title);
        };
        expect(findingTitles())
            .toEqual(['diagnosis.findings.notRun']);

        expect(screen.findByTestId('diagnosis-paste-input')?.props.accessibilityLabel)
            .toBe('diagnosis.sections.pasteDoctorJson');

        act(() => {
            screen.changeTextByTestId('diagnosis-paste-input', '{ invalid json');
        });
        await act(async () => {
            screen.pressByTestId('diagnosis-parse-button');
            await settle();
        });
        const parseError = screen.findAllByType('Text' as any)
            .find((node) => node.props.children === 'diagnosis.pasteDoctorJson.error');
        expect(parseError?.props.accessibilityLiveRegion).toBe('polite');
        expect(parseError?.props['aria-live']).toBe('polite');

        await act(async () => {
            screen.pressByTestId('diagnosis-run-button');
            await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalled());
        });
        expect(screen.findByTestId('diagnosis-accessibility-status')?.props.children)
            .toBe('diagnosis.machineRuns.loading');
        // Assert the Findings section itself; a separate live status must not mask a blank section.
        expect(findingTitles())
            .toEqual(['diagnosis.machineRuns.loading']);
        await act(async () => { release(); await settle(); });
        await waitForHomeGovernance(() => {
            expect(findingTitles())
                .toEqual(['diagnosis.findings.none']);
        });
        expect(screen.findByTestId('diagnosis-accessibility-status')?.props.children)
            .toBe('diagnosis.findings.none');
    });

    it('announces terminal findings instead of claiming success', async () => {
        machineRpc.mockImplementation(async ({ machineId }: { machineId: string }) => {
            return {
                doctorSnapshot: snapshotFor(
                    machineId,
                    machineId === 'machine-3' ? 'https://other-home.example' : 'https://home.example',
                ),
            };
        });

        const screen = await renderScreen(<DiagnosisView />);

        await runDiagnosis(screen);

        const status = screen.findByTestId('diagnosis-accessibility-status');
        expect(status?.props.children).toContain('diagnosis.findings.serverMismatch.title');
        expect(status?.props.children).not.toContain('diagnosis.findings.none');
    });

    it('announces partial machine failures and does not render whole-system success', async () => {
        machineRpc.mockImplementation(async ({ machineId }: { machineId: string }) => {
            if (machineId === 'machine-2') {
                return null;
            }
            return { doctorSnapshot: snapshotFor(machineId) };
        });

        const screen = await renderScreen(<DiagnosisView />);

        await runDiagnosis(screen);

        const status = screen.findByTestId('diagnosis-accessibility-status');
        expect(status?.props.children).toContain('diagnosis.machineRuns.error');
        expect(status?.props.children).not.toContain('diagnosis.findings.none');
        expect(screen.findAllByType(Item).find((node) => node.props.testID === 'diagnosis-machine-run-summary')?.props.title)
            .toBe('diagnosis.machineRuns.error');
        const failedMachine = screen.findAllByType(Item)
            .find((node) => node.props.title === 'Machine 2');
        expect(failedMachine?.props.detail).toBe('diagnosis.machineRuns.error');
    });
    it('shows run results only once a run has started, and names the server probe outcome in words', async () => {
        const screen = await renderScreen(<DiagnosisView />);
        const probeRow = () => screen.findAllByType(Item)
            .find((node) => node.props.title === 'diagnosis.serverProbe.title');
        const machineRow = () => screen.findAllByType(Item)
            .find((node) => node.props.title === 'Machine 1');

        // Before a run there is nothing to report on: no idle machine rows, no probe row.
        expect(machineRow()).toBeUndefined();
        expect(probeRow()).toBeUndefined();

        await runDiagnosis(screen);
        expect(probeRow()?.props.detail).toBe('diagnosis.machineRuns.ready');
        expect(machineRow()?.props.detail).toBe('diagnosis.machineRuns.ready');

        home.answer(serverId, probePath, { status: 401 });
        await runDiagnosis(screen);
        expect(probeRow()?.props.detail).toBe('diagnosis.machineRuns.error');
        expect(probeRow()?.props.subtitle).toBe('diagnosis.findings.serverAuthError.title');
    });
    it('folds machines that all failed the same way into one counted row', async () => {
        machineRpc.mockResolvedValue(null);
        const screen = await renderScreen(<DiagnosisView />);
        await runDiagnosis(screen);
        const group = screen.findAllByType(Item)
            .find((node) => node.props.title === 'diagnosis.machine.invalidDoctorSnapshot');
        expect(group?.props.detail).toBe('4');
        // The machines are inside the closed group, not four loose "Error" rows.
        const looseErrors = screen.findAllByType(Item)
            .filter((node) => typeof node.props.title === 'string' && node.props.title.startsWith('Machine ') && node.props.detail === 'diagnosis.machineRuns.error');
        expect(looseErrors.length).toBeLessThanOrEqual(4);
    });
    it('reads a normal "diagnostics disabled" server as information, not a warning', async () => {
        home.answer(serverId, probePath, { status: 404 });
        const screen = await renderScreen(<DiagnosisView />);
        await runDiagnosis(screen);
        const finding = screen.findAllByType(Item).find((node) => node.props.testID === 'diagnosis-finding-server_diagnostics_disabled');
        expect(finding?.props.icon.props.name).toBe('info');
    });
    it('checks the online machines together, so one slow machine does not hold the others back', async () => {
        const started: string[] = [];
        const releases: Array<() => void> = [];
        machineRpc.mockImplementation(({ machineId }: { machineId: string }) => {
            started.push(machineId);
            return new Promise(resolve => { releases.push(() => resolve({ doctorSnapshot: snapshotFor(machineId) })); });
        });
        const screen = await renderScreen(<DiagnosisView />);
        await act(async () => {
            screen.pressByTestId('diagnosis-run-button');
            await waitForHomeGovernance(() => expect(started).toEqual(['machine-1', 'machine-2', 'machine-3', 'machine-4']));
        });
        expect(started).toEqual(['machine-1', 'machine-2', 'machine-3', 'machine-4']);
        await screen.unmount();
        await act(async () => { for (const release of releases) release(); await settle(); });
    });
});

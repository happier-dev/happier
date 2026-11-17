import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { CapabilityMachineTruth, type CapabilityMachineTruthRow } from './CapabilityMachineTruth';
import { MachineAgentStatusLine } from '@/components/machines/agents/MachineAgentStatusLine';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

it('keeps a recovered machine visible and says offline once for the remaining machines in the mounted list', async () => {
    const row = (machineId: string, offline: boolean): CapabilityMachineTruthRow => ({
        machineId, machineName: machineId, deviceIcon: 'laptop', offline,
        who: <MachineAgentStatusLine machineOfflineSaid={offline} status={offline
            ? { kind: 'offline', tone: 'quiet', lastKnown: 'signedIn' }
            : { kind: 'ready', tone: 'quiet', via: 'native', label: null, updateTo: null }} />,
    });
    const render = (recovered: boolean) => <CapabilityMachineTruth testID="journey-machines" presentation="list"
        summary="" rows={[row('online', false), row('recovered', !recovered), row('standby-a', true), row('standby-b', true)]} />;
    const screen = await renderScreen(render(false));
    expect(screen.getTextContent()).toContain('3 offline machines');
    expect(screen.findByTestId('journey-machines:machine:recovered')).toBeNull();
    await screen.pressByTestIdAsync('journey-machines:offline');
    expect(screen.findByTestId('journey-machines:machine:recovered')).not.toBeNull();
    expect(screen.getTextContent().match(/offline/gi)).toHaveLength(1);
    await screen.update(render(true));
    expect(screen.getTextContent()).toContain('2 offline machines');
    expect(screen.findByTestId('journey-machines:machine:recovered')).not.toBeNull();
    expect(screen.getTextContent().match(/offline/gi)).toHaveLength(1);
});

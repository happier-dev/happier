import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

const { MachineAdministrationContextBar } = await import('./MachineAdministrationContextBar');

function textsOf(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.root
        .findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map((node) => node.props.children as string);
}

describe('MachineAdministrationContextBar', () => {
    it.each([
        ['a selected machine', createMachineAdministrationTargetSelectionFixture()],
        ['an offline machine', createMachineAdministrationTargetSelectionFixture({
            machines: [{ machineId: 'machine-a', displayName: 'Mac', availability: 'offline' }],
        })],
        ['a selection whose machine is gone', createMachineAdministrationTargetSelectionFixture({
            machines: [{ machineId: 'machine-b', displayName: 'Other' }],
            selectedMachineId: 'machine-a',
        })],
        ['no machines at all', createMachineAdministrationTargetSelectionFixture({ machines: [], selectedMachineId: null })],
    ])('keeps its label and the machine chip with %s, since the chip is how the page recovers', async (_state, selection) => {
        const screen = await renderScreen(
            <MachineAdministrationContextBar label="Setup and status on" selection={selection} testIDPrefix="agent.target" />,
        );
        expect(textsOf(screen)).toContain('Setup and status on');
        expect(screen.findHostByTestId('agent.target.chip')).not.toBeNull();
    });
});

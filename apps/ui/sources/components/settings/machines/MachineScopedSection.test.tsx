import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import { Text } from '@/components/ui/text/Text';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => (params && 'machine' in params ? `${key}:${String(params.machine)}` : key),
        });
    },
});

const { MachineScopedSection } = await import('./MachineScopedSection');

const push = vi.fn();

async function renderSection(
    selection: ReturnType<typeof createMachineAdministrationTargetSelectionFixture>,
    options: Readonly<{ lockedReason?: string }> = {},
) {
    return await renderScreen(
        <DestinationInstanceHost tabId="machine-scoped-section" ref={{ kind: 'settings', params: {} }}
            pathname="/settings/providers" focused visible phone={false}
            navigation={{ push, replace: () => {}, back: () => {} }}>
            {/* Every consumer is a page; the section header (and its chip) is page anatomy. */}
            <ListPresentationProvider value="page">
            <MachineScopedSection
                title="On this computer"
                selection={selection}
                unselectedInvitation="Choose one to test this connection."
                offlineDetail="Last test: working."
                lockedReason={options.lockedReason}
                testIDPrefix="scope"
            >
                <Text>online rows</Text>
            </MachineScopedSection>
            </ListPresentationProvider>
        </DestinationInstanceHost>,
    );
}

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.root
        .findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map((node) => node.props.children as string);
}

describe('MachineScopedSection', () => {
    afterEach(() => {
        push.mockReset();
        standardCleanup();
    });

    it('renders the computer rows only while the chosen machine is online', async () => {
        const screen = await renderSection(createMachineAdministrationTargetSelectionFixture());
        expect(texts(screen)).toContain('online rows');
        expect(screen.findHostByTestId('scope.state')).toBeNull();
        // The chip stays in the section header: it is how every other state recovers.
        expect(screen.findHostByTestId('scope.chip')).not.toBeNull();
    });

    it('says what a computer is for and opens the machine list when none is chosen', async () => {
        const screen = await renderSection(createMachineAdministrationTargetSelectionFixture({
            machines: [{ machineId: 'machine-a', displayName: 'Mac' }, { machineId: 'machine-b', displayName: 'Studio' }],
            selectedMachineId: null,
        }));
        expect(texts(screen)).not.toContain('online rows');
        expect(texts(screen)).toContain('Choose one to test this connection.');
        expect(screen.findHostByTestId('scope.choose')).not.toBeNull();
        expect(screen.findHostByTestId('scope.setUp')).toBeNull();
    });

    it('leads to setting a computer up when there is none to choose', async () => {
        const screen = await renderSection(createMachineAdministrationTargetSelectionFixture({ machines: [], selectedMachineId: null }));
        expect(screen.findHostByTestId('scope.choose')).toBeNull();
        await screen.pressByTestIdAsync('scope.setUp');
        expect(push).toHaveBeenCalledWith('/(app)/settings/machines');
    });

    it('names an offline machine and keeps its last known fact instead of its rows', async () => {
        const screen = await renderSection(createMachineAdministrationTargetSelectionFixture({
            machines: [{ machineId: 'machine-a', displayName: 'devbox', availability: 'offline' }],
        }));
        expect(texts(screen)).not.toContain('online rows');
        expect(texts(screen)).toContain('settingsMachines.scopeOffline:devbox Last test: working.');
        expect(screen.findHostByTestId('scope.chooseAnother')).not.toBeNull();
    });

    it('explains a locked machine by its cause rather than calling it offline', async () => {
        const screen = await renderSection(createMachineAdministrationTargetSelectionFixture({
            machines: [{ machineId: 'machine-a', displayName: 'devbox', availability: 'locked' }],
        }), { lockedReason: 'Its key is missing.' });
        expect(texts(screen)).not.toContain('online rows');
        const line = texts(screen).find((text) => text.includes('Its key is missing.'));
        expect(line).toBeDefined();
        expect(line).not.toContain('settingsMachines.scopeOffline');
    });

    it('does not call a machine gone while its Home is still listing machines', async () => {
        const fixture = createMachineAdministrationTargetSelectionFixture({ machines: [], selectedMachineId: 'machine-a' });
        const screen = await renderSection({
            ...fixture,
            // The Home has not answered with its machine list yet.
            state: resolveMachineAdministrationTargetState({ storedTarget: fixture.selectedTarget, candidates: [] }),
        });
        expect(screen.findHostByTestId('scope.chooseAnother')).toBeNull();
        expect(screen.findHostByTestId('scope.state')).not.toBeNull();
    });
});

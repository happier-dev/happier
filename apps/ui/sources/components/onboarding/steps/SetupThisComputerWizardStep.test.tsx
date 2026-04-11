import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const setupChecklistStepMock = vi.fn((props: Record<string, unknown>) => React.createElement('SetupThisComputerChecklistStep', props));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('../checklists/setupThisComputer/SetupThisComputerChecklistStep', () => ({
    SetupThisComputerChecklistStep: (props: Record<string, unknown>) => setupChecklistStepMock(props),
}));

describe('SetupThisComputerWizardStep', () => {
    it('forwards the wizard step props to the checklist adapter', async () => {
        const { SetupThisComputerWizardStep } = await import('./SetupThisComputerWizardStep');
        const screen = await renderScreen(
            <SetupThisComputerWizardStep
                testID="wizard-setup-this-computer"
                onSucceeded={() => {}}
                onNeedsAuth={() => {}}
            />,
        );

        expect(screen.findByType('SetupThisComputerChecklistStep' as never)).toBeTruthy();
        expect(setupChecklistStepMock).toHaveBeenCalledWith(expect.objectContaining({
            testID: 'wizard-setup-this-computer',
            onSucceeded: expect.any(Function),
            onNeedsAuth: expect.any(Function),
        }));
    });
});

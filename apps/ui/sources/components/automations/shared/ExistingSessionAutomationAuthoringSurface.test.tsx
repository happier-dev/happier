import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';

installAutomationComponentCommonModuleMocks();

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationComposer', () => ({
    ExistingSessionAutomationComposer: (props: any) => React.createElement('ExistingSessionAutomationComposer', props),
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationContextSection', () => ({
    ExistingSessionAutomationContextSection: (props: any) => React.createElement('ExistingSessionAutomationContextSection', props),
}));

vi.mock('@/components/automations/shared/ExistingSessionAutomationUnavailableNotice', () => ({
    ExistingSessionAutomationUnavailableNotice: (props: any) => React.createElement('ExistingSessionAutomationUnavailableNotice', props),
}));

vi.mock('@/components/sessions/agentInput/definitions/createAutomationToggleActionChip', () => ({
    createAutomationToggleActionChip: () => ({ id: 'automation-toggle-chip' }),
}));

vi.mock('@/components/sessions/authoring/context/buildExistingSessionAutomationAuthoringContext', () => ({
    buildExistingSessionAutomationAuthoringContext: () => ({ id: 'ctx' }),
}));

describe('ExistingSessionAutomationAuthoringSurface', () => {
    it('keeps hook order stable when transitioning from waiting to ready', async () => {
        const { ExistingSessionAutomationAuthoringSurface } = await import('./ExistingSessionAutomationAuthoringSurface');
        const onChangeDraft = vi.fn();
        const onSubmit = vi.fn();

        const readyProps = {
            formVariant: 'create' as const,
            session: {
                id: 's1',
                metadata: {},
            } as any,
            draft: {
                prompt: 'hello',
                sessionEncryptionKeyBase64: null,
                automation: {
                    enabled: true,
                    name: 'Automation name',
                },
            } as any,
            onChangeDraft,
            availability: { kind: 'ready', machineId: 'm1' } as any,
            isWaiting: false,
            unavailableReason: null,
            onSubmit,
            submitAccessibilityLabel: 'Create automation',
            isSubmitDisabled: false,
        };

        const screen = await renderScreen(
            <ExistingSessionAutomationAuthoringSurface
                {...readyProps}
                session={null}
                draft={null}
                availability={{ kind: 'hydrating' } as any}
                isWaiting
            />,
        );

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);

        await act(async () => {
            screen.tree.update(
                <ExistingSessionAutomationAuthoringSurface {...readyProps} />,
            );
        });

        expect(screen.findAllByType('ExistingSessionAutomationContextSection')).toHaveLength(1);
        expect(screen.findAllByType('ExistingSessionAutomationComposer')).toHaveLength(1);
    });
});

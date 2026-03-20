import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { SessionAuthoringAutomationToggleChip } from '@/components/sessions/authoring/automation/SessionAuthoringAutomationToggleChip';

export function createAutomationToggleActionChip(params: Readonly<{
    enabled: boolean;
    label: string;
    onValueChange: (next: boolean) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-automate',
        controlId: 'automation',
        collapsedAction: ({ dismiss }) => ({
            id: 'new-session-automate',
            label: params.label,
            icon: null,
            onPress: () => {
                dismiss();
                params.onValueChange(!params.enabled);
            },
        }),
        render: ({ chipStyle, showLabel, textStyle }) => (
            <SessionAuthoringAutomationToggleChip
                value={params.enabled}
                label={params.label}
                onValueChange={params.onValueChange}
                chipStyle={chipStyle}
                showLabel={showLabel}
                textStyle={textStyle}
            />
        ),
    };
}

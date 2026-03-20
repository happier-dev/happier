import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { SessionLinkFileAction } from '@/components/sessions/linkedFiles/projectPicker/SessionLinkFileAction';
import { t } from '@/text';

export function createLinkedFilesActionChip(params: Readonly<{
    sessionId: string;
    disabled: boolean;
    open: boolean;
    onOpenChange: (next: boolean) => void;
    onPickPath: (path: string) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'project-file-link',
        controlId: 'linkedFiles',
        labelPolicy: 'auto-hide',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'linked-files',
            label: t('common.linkFile'),
            icon: <Ionicons name="document-outline" size={16} color={tint} />,
            onPress: () => {
                dismiss();
                params.onOpenChange(true);
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <SessionLinkFileAction
                sessionId={params.sessionId}
                disabled={params.disabled}
                open={params.open}
                onOpenChange={params.onOpenChange}
                showLabel={ctx.showLabel}
                chipStyle={ctx.chipStyle}
                iconColor={ctx.iconColor}
                textStyle={ctx.textStyle}
                popoverAnchorRef={ctx.popoverAnchorRef}
                onPickPath={params.onPickPath}
            />
        ),
    };
}

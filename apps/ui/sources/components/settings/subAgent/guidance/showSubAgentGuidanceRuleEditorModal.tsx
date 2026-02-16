import * as React from 'react';

import { Modal } from '@/modal';

import type { ExecutionRunsGuidanceEntry } from '@/sync/domains/settings/executionRunsGuidance';
import { SubAgentGuidanceRuleEditorModal } from './subAgentGuidanceRuleEditorModal';

export type SubAgentGuidanceRuleEditorResult =
    | { kind: 'save'; entry: ExecutionRunsGuidanceEntry }
    | { kind: 'delete' };

export async function showSubAgentGuidanceRuleEditorModal(params: Readonly<{
    mode: 'create' | 'edit';
    entry: ExecutionRunsGuidanceEntry;
}>): Promise<SubAgentGuidanceRuleEditorResult | null> {
    return await new Promise((resolve) => {
        type WrapperProps = Readonly<{ onRequestClose?: () => void; onClose: () => void }>;

        const Wrapper: React.FC<WrapperProps> = ({ onClose }) => (
            <SubAgentGuidanceRuleEditorModal
                mode={params.mode}
                entry={params.entry}
                onResolve={(value) => {
                    resolve(value);
                    onClose();
                }}
                onClose={onClose}
            />
        );

        Modal.show({
            component: Wrapper,
            props: {
                onRequestClose: () => resolve(null),
            },
            closeOnBackdrop: true,
        });
    });
}


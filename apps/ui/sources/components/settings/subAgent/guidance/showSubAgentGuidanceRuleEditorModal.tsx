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
        Modal.show({
            component: SubAgentGuidanceRuleEditorModal,
            props: {
                mode: params.mode,
                entry: params.entry,
                onResolve: (value: SubAgentGuidanceRuleEditorResult | null) => resolve(value),
            },
            onRequestClose: () => resolve(null),
            closeOnBackdrop: true,
        });
    });
}

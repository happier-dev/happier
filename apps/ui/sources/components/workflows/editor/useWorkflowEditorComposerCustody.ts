import * as React from 'react';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { findWorkflowBlock, updateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { readObservedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    useWorkflowAuthoringComposerCustody,
    type AuthoringComposerHostBinding,
    type AuthoringComposerSeed,
} from '@/components/sessions/authoring/authoringComposerCustody';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

/** Draft and focus callbacks belong to the page, never to a row that may become a summary. */
export function useWorkflowEditorComposerCustody(input: Readonly<{
    /** The draft as it is now; custody reads it when a document is read or changed, not per render. */
    readDraft: () => WorkflowEditorDraft;
    draftId: string;
    blockIds: readonly string[];
    scope: AuthoringComposerScope;
    seeds?: readonly AuthoringComposerSeed[];
    editable: boolean;
    onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => void;
    onSelect: (blockId: string) => void;
    focusPrompt: (blockId: string) => void;
}>) {
    const sessionId = input.scope.kind === 'session' ? input.scope.sessionId : null;
    const preferredServerId = usePreferredServerIdForSession(
        { serverId: input.scope.serverId, sessionId: sessionId ?? '' }, sessionId !== null,
    );
    const sessionMachine = useSessionMachineTarget(sessionId, preferredServerId);
    const machineId = input.scope.kind === 'machine' ? input.scope.machineId : sessionMachine?.machineId ?? null;
    const serverId = input.scope.kind === 'machine' ? input.scope.serverId : preferredServerId;
    const presented = useLayoutPresentationActive();
    const latest = React.useRef({ ...input, machineId, serverId, presented });
    latest.current = { ...input, machineId, serverId, presented };
    const host = React.useMemo<AuthoringComposerHostBinding>(() => ({
        editable: () => latest.current.editable,
        presented: () => latest.current.presented,
        readDocument: blockId => {
            const block = findWorkflowBlock(latest.current.readDraft(), blockId);
            return block?.kind === 'step' || block?.kind === 'wait' ? block.document : null;
        },
        onDocumentChange: (blockId, document) => {
            const current = latest.current;
            current.onChange(updateWorkflowBlock(current.readDraft(), blockId, block =>
                block.kind === 'step' || block.kind === 'wait' ? { ...block, document: {
                    text: document.text, references: [...document.references],
                    attachments: document.attachments.map(attachment => ({ ...attachment,
                        value: PluginJsonValueV2Schema.parse(attachment.value),
                    })),
                } } : block,
            ), t('workflows.editor.history.document'), false);
        },
        focusDocument: blockId => {
            latest.current.onSelect(blockId);
            latest.current.focusPrompt(blockId);
        },
        readAttachmentComposition: accountLifetime => {
            const { machineId, serverId } = latest.current;
            const entry = readObservedDaemonMergedProjectionCacheEntry({ machineId, serverId, accountLifetime,
                sections: ['familiesById.composerAttachments'],
            });
            if (entry?.kind !== 'ready') return null;
            const projection = entry.inputs.pluginUiProjection;
            return { composerAttachmentsById: projection.composerAttachmentsById,
                localize: createPluginLocalizedTextResolver({ projection }),
            };
        },
    }), []);
    return useWorkflowAuthoringComposerCustody({ draftId: input.draftId, blockIds: input.blockIds,
        ...(input.seeds === undefined ? {} : { seeds: input.seeds }), host,
    });
}

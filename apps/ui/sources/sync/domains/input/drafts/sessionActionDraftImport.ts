import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import * as sessionDraftRepository from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import { loadSessionActionDrafts, removeImportedSessionActionDrafts } from '@/sync/domains/state/sessionPersistence';
import { executionRunLauncherDraftKey } from '@/components/sessions/agents/launch/agentStartDrafts';
import { EXECUTION_RUN_LAUNCH_INTENTS, resolveExecutionRunLauncherActionId, type ExecutionRunIntent } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { randomUUID } from '@/platform/randomUUID';

/** Retired cards feed the ordinary Session launcher, never an active transcript store. */
export async function importSessionActionDrafts(
    scope: ServerAccountScope,
): Promise<void> {
    for (const drafts of Object.values(loadSessionActionDrafts(scope))) {
        const byKey = new Map<string, { intent: ExecutionRunIntent; drafts: typeof drafts }>();
        for (const draft of drafts) {
            if (draft.status !== 'editing' && draft.status !== 'failed') continue;
            const intent = EXECUTION_RUN_LAUNCH_INTENTS.find(value => resolveExecutionRunLauncherActionId(value) === draft.actionId);
            if (!intent) continue;
            const key = executionRunLauncherDraftKey({ intent, roleId: typeof draft.input.roleId === 'string' ? draft.input.roleId : null });
            const group = byKey.get(key);
            if (group) group.drafts.push(draft);
            else byKey.set(key, { intent, drafts: [draft] });
        }
        for (const [key, { intent, drafts: imported }] of byKey) {
            const sessionId = imported[0]!.address.sessionId;
            const document = sessionDraftRepository.getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.document ?? null;
            const textField = getSessionDraftDocumentField(document, sessionDraftRepository.executionRunLauncherDraftFieldPath(key, 'text'));
            const selection = getSessionDraftDocumentField(document, sessionDraftRepository.executionRunLauncherDraftFieldPath(key, 'selection'));
            const existing = typeof textField?.value === 'string' ? textField.value : '';
            const instructions = imported.map(draft => typeof draft.input.instructions === 'string' ? draft.input.instructions : '')
                .filter(Boolean).join('\n\n');
            // Preserve every collision's instructions. An interrupted source retirement can leave
            // a visible, editable duplicate on retry; the original source remains recoverable.
            const text = [existing, instructions].filter(Boolean).join('\n\n');
            sessionDraftRepository.writeExistingSessionDraft({ scope, sessionId, materializationIntent: 'seeded',
                patch: { executionRunLauncher: { key, patch: { text,
                    ...(!selection ? { selection: StrictJsonValueSchema.parse({
                        identity: { correlationId: randomUUID(), inputLocalId: randomUUID() },
                        actionInput: buildExecutionRunActionDraftInputForUi({
                            actionId: resolveExecutionRunLauncherActionId(intent),
                            sessionId,
                            instructions: '',
                            extra: { ...imported[0]!.input, sessionId, instructions: '' },
                        }),
                    }) } : {}),
                } } },
            });
            await sessionDraftRepository.flushSessionDraftLocally({ scope });
            removeImportedSessionActionDrafts(imported, scope);
        }
    }
}

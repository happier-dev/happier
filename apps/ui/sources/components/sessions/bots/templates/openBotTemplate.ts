import * as React from 'react';
import { readSessionStateFieldFromMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { BotTemplateActionOutputSchemasV1, type BotTemplateOpenInputV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { projectBotTemplateFaceV1, type BotTemplateSourceSessionRefV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { PromptDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { readSessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextLocalCommands, type CurrentUiContextCommandInvocation,
    type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { Modal } from '@/modal';
import { buildBotTemplateEditorRoute, BOT_TEMPLATE_EDITOR_DESTINATION, createBotTemplateEditorDetailsTab } from './botTemplateEditorDestination';
import { useOptionalDetailsRegionTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { selectSessionInstructionsRef } from '@/components/sessions/work/useSessionInstructionsSource';
import { readUiBotTemplatePet } from '@/sync/ops/actions/botTemplateActionDeps';
export { buildBotTemplateEditorRoute, createBotTemplateEditorDetailsTab, readBotTemplateEditorResource } from './botTemplateEditorDestination';
export type SessionBotTemplateSource = Pick<Session, 'id' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'access'>;

/** Every authored entry reads the owner-private address, never a whole Artifact inventory. */
export function readSessionTemplateDraftRef(session: SessionBotTemplateSource) {
    const metadata = readSessionOwnerMetadataView(session);
    return metadata ? readSessionStateFieldFromMetadata(metadata, 'intent.templateDraftRef') ?? null : null;
}

/**
 * Initial creation and a deleted/dangling draft call `template.draft` directly with what this Bot is now (its name,
 * face, Agent and Instructions), then open the private draft in the editor through `template.open`. The person reviews and
 * edits it there; nothing is shared. Never a chat message naming an Action.
 */
export async function requestBotTemplateDraft(execute: ReturnType<typeof useMountedActionExecution>['execute'],
    session: SessionBotTemplateSource & Parameters<typeof getSessionName>[0], serverId: string): Promise<ActionExecuteResult> {
    const sourceSessionRef: BotTemplateSourceSessionRefV1 = { serverId, sessionId: session.id };
    const metadata = readSessionOwnerMetadataView(session);
    const instructionsRef = selectSessionInstructionsRef(metadata).ref;
    // The Agent this Bot runs on is the template's starting suggestion; the author can change it in the editor.
    const agentId = metadata ? resolveAgentIdFromSessionMetadata(metadata) : null;
    const instructions = instructionsRef ? await execute('prompt_doc.get', { artifactId: instructionsRef.artifactId }) : null;
    const document = instructions?.ok ? PromptDocReadResultV1Schema.safeParse(instructions.result) : null;
    const face = readSessionBotFaceV1(session.metadata?.botFace);
    const pet = face?.pet?.kind === 'accountPet'
        ? await readUiBotTemplatePet(serverId, face.pet.accountPetId).catch((error: unknown) => {
            const errorCode = readActionErrorCodeV1(error) ?? 'action_failed';
            return { ok: false as const, errorCode, error: errorCode };
        }) : null;
    if (pet && !pet.ok) return pet;
    const drafted = await execute('template.draft', { sourceSessionRef, content: {
        v: 1, identity: { name: getSessionName(session, sourceSessionRef.serverId), description: '', ...(face ? { face: projectBotTemplateFaceV1(face) } : {}) },
        ...(pet?.ok ? { pet: pet.pet } : {}),
        instructions: { markdown: document?.success ? document.data.markdown : '' },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] },
        ...(agentId ? { suggestedAgent: { agentId } } : {}),
    } });
    if (!drafted.ok) return drafted;
    const draft = BotTemplateActionOutputSchemasV1['template.draft'].safeParse(drafted.result);
    if (!draft.success) return { ok: false, errorCode: 'invalid_result', error: 'invalid_result' };
    return execute('template.open', { draftArtifactId: draft.data.draftArtifactId, sourceSessionRef, presentation: 'pane' });
}

export function useOpenBotTemplate(session: SessionBotTemplateSource | null, serverId: string, registerCommand = false) {
    const sessionId = session?.id ?? '';
    const open = usePresentBotTemplate(sessionId, serverId);
    const executorOptions = React.useMemo(() => ({ openBotTemplate: open }), [open]);
    const actions = useMountedActionExecution(serverId, { executorOptions });
    const current = React.useRef(session);
    current.current = session;
    const available = session !== null && readSessionBotV1(session.metadata?.bot)?.kind === 'bot'
        && (readSessionTemplateDraftRef(session) !== null || session.access?.capabilities.submitAgentInput === true);
    const invoke = React.useCallback(async (invocation?: CurrentUiContextCommandInvocation) => {
        const source = current.current;
        if (!source) return;
        const ref = readSessionTemplateDraftRef(source);
        const execute: typeof actions.execute = (actionId, input, operation) => invocation
            ? invocation.execute(actions, actionId, input, operation) : actions.execute(actionId, input, operation);
        const result = ref ? await execute('template.open', { draftArtifactId: ref.artifactId,
            sourceSessionRef: { serverId: ref.serverId, sessionId }, presentation: 'pane' })
            : await requestBotTemplateDraft(execute, source, serverId);
        // Taking Info's pane retires its mounted command. That cancellation says
        // nothing about the template now presented by the successor view.
        if (!result.ok && actions.isCurrent()) await Modal.alert(t('common.error'), t('botTemplates.unavailable'));
        return result;
    }, [actions.execute, actions.executeForCaller, actions.binding, actions.isCurrent, serverId, sessionId]);
    const commands = React.useMemo<readonly CurrentUiContextLocalCommand[]>(() => registerCommand && available ? [{ key: BOT_TEMPLATE_EDITOR_DESTINATION,
        title: t('botTemplates.giveCopy'), description: t('botTemplates.giveCopyDescription'),
        invoke: async (_input, _caller, invocation) => {
            const result = await invoke(invocation);
            return result?.ok === false ? { ok: false, code: 'denied', errorCode: result.errorCode } : { ok: true };
        } }] : [], [invoke, registerCommand, available]);
    useCurrentUiContextLocalCommands(commands);
    const touch = React.useCallback(() => invoke(), [invoke]);
    return available ? touch : null;
}

export function usePresentBotTemplate(sessionId: string, serverId: string) {
    const router = useRouter();
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(sessionId, serverId));
    const openDetailsTab = useOptionalDetailsRegionTabOpener();
    const open = React.useCallback(async (input: BotTemplateOpenInputV1) => {
        if (input.presentation === 'page') router.pushRetainingCurrent(buildBotTemplateEditorRoute(input) as never);
        else {
            const tab = createBotTemplateEditorDetailsTab({ artifactId: input.draftArtifactId, serverId: input.sourceSessionRef.serverId });
            openDetailsTab?.(scopeId, tab, { intent: 'pinned', start: true });
        }
    }, [router, openDetailsTab, scopeId]);
    return open;
}

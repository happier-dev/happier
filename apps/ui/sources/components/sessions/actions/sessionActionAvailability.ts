import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
    SESSION_ACTION_MAKE_BOT_ID,
    SESSION_ACTION_MAKE_REGULAR_ID,
    SESSION_ACTION_RAIL_PIN_ID,
    SESSION_ACTION_RAIL_UNPIN_ID,
    SESSION_ACTION_WORK_OPEN_ID,
    SESSION_ACTION_TALK_ID,
    SESSION_ACTION_TOOL_CALLS_TOGGLE_ID,
    SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_FOLLOW_ID,
    SESSION_ACTION_MAKE_ORCHESTRATOR_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PUT_UNDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
} from './sessionActionIds';
import type { SessionActionId, SessionActionSurface, SessionActionTarget } from './sessionActionTypes';

export function resolveSessionReadStateActionId(target: SessionActionTarget): SessionActionId | null {
    if (!target.readStateAction.visible) return null;
    return target.readStateAction.targetState === 'read'
        ? SESSION_ACTION_MARK_READ_ID
        : SESSION_ACTION_MARK_UNREAD_ID;
}

export function resolveSessionAttentionStandingActionId(target: SessionActionTarget): SessionActionId | null {
    if (!target.attentionStandingAction.visible) return null;
    return target.attentionStandingAction.targetStanding
        ? SESSION_ACTION_SET_ATTENTION_STANDING_ID
        : SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID;
}

export function listVisibleSessionActionIds(params: Readonly<{
    target: SessionActionTarget;
    surface: SessionActionSurface;
}>): SessionActionId[] {
    const { target, surface } = params;
    const ids: SessionActionId[] = [];
    if (surface === 'botsRoster') {
        // The roster's compact menu (lab `b-rail M`): Talk, the rail choice, Instructions and voice,
        // then the way back to a regular session. Everything else stays in the session's own menu.
        if (target.serverId === null || target.session.access?.capabilities.readTranscript !== true) return ids;
        const isBot = readSessionBotV1(target.session.metadata?.bot)?.kind === 'bot';
        const voiceAction = getActionSpec('ui.voice_global.start');
        if (isBot && voiceAction.surfaces.ui && voiceAction.executionPlacement === 'client') ids.push(SESSION_ACTION_TALK_ID);
        if (target.isRailPinned) ids.push(SESSION_ACTION_RAIL_UNPIN_ID);
        else if (isBot) ids.push(SESSION_ACTION_RAIL_PIN_ID);
        if (isBot) ids.push(SESSION_ACTION_WORK_OPEN_ID);
        if (isBot && target.canRename && target.canWriteOwnerMetadata) ids.push(SESSION_ACTION_MAKE_REGULAR_ID);
        return ids;
    }
    // The session's own menu opens its "This session" rows with the name, then the rail choice and
    // Talk (lab `b-promote`); the other surfaces keep their established order.
    if (surface === 'sessionHeader' && target.canRename) ids.push(SESSION_ACTION_RENAME_ID);
    if (surface !== 'selectionActionBar' && target.serverId !== null
        && target.session.access?.capabilities.readTranscript === true) {
        if (target.isRailPinned) ids.push(SESSION_ACTION_RAIL_UNPIN_ID);
        else if (readSessionBotV1(target.session.metadata?.bot)?.kind === 'bot') ids.push(SESSION_ACTION_RAIL_PIN_ID);
        if (readSessionBotV1(target.session.metadata?.bot)?.kind === 'bot') {
            ids.push(SESSION_ACTION_WORK_OPEN_ID);
            const voiceAction = getActionSpec('ui.voice_global.start');
            if (voiceAction.surfaces.ui && voiceAction.executionPlacement === 'client') ids.push(SESSION_ACTION_TALK_ID);
        }
    }
    if (surface !== 'selectionActionBar' && target.followEnabled === true && target.serverId?.trim()) {
        ids.push(SESSION_ACTION_FOLLOW_ID);
    }
    const readStateId = resolveSessionReadStateActionId(target);

    if (readStateId) {
        ids.push(readStateId);
    }

    const attentionStandingId = resolveSessionAttentionStandingActionId(target);
    if (attentionStandingId) {
        ids.push(attentionStandingId);
    }

    if (target.canRename) {
        if (surface !== 'sessionHeader') ids.push(SESSION_ACTION_RENAME_ID);
        if (surface !== 'selectionActionBar' && target.canWriteOwnerMetadata) {
            const marker = readSessionBotV1(target.session.metadata?.bot);
            ids.push(marker?.kind === 'bot' ? SESSION_ACTION_MAKE_REGULAR_ID : SESSION_ACTION_MAKE_BOT_ID);
        }
    }
    if (surface !== 'selectionActionBar' && target.canWriteOwnerMetadata) {
        ids.push(SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID);
    }

    // "Make this an orchestrator" lives in the Session's own ⋯ (ORC §3.8); choosing a Session's role
    // needs the same authority as naming it.
    if (surface === 'sessionHeader' && target.canRename && !target.isArchived) {
        ids.push(SESSION_ACTION_MAKE_ORCHESTRATOR_ID);
    }

    if (surface === 'sessionHeader' && target.canResume) {
        ids.push(SESSION_ACTION_RESUME_ID);
    }

    // Reporting to a lead needs input rights on this Session (the server also checks the lead).
    if (
        (surface === 'rowMenu' || surface === 'nativeContextMenu' || surface === 'sessionHeader')
        && !target.isArchived
        && target.session.access?.capabilities.submitAgentInput === true
    ) {
        ids.push(SESSION_ACTION_PUT_UNDER_ID);
    }

    if (target.canStop && (target.isActive || target.hasRecoverableTerminalHost)) {
        ids.push(SESSION_ACTION_STOP_ID);
    }

    if (target.canArchive) {
        ids.push(SESSION_ACTION_ARCHIVE_ID);
    }

    if (target.isArchived && target.canUnarchive) {
        ids.push(SESSION_ACTION_UNARCHIVE_ID);
    }

    if (surface === 'sessionInfo' && target.canDelete) {
        ids.push(SESSION_ACTION_DELETE_ID);
    }

    if (surface === 'rowMenu' || surface === 'nativeContextMenu') {
        ids.push(SESSION_ACTION_MOVE_TO_FOLDER_ID);
    }


    return ids;
}

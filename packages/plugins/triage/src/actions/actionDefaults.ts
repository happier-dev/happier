import { PluginError } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1, type TriageSaveActionDefaultsInputV1 } from '@happier-dev/triage-protocol/v1';
import { resolveLaunchProfilePlacementDirectoryIntentV1 } from '@happier-dev/plugin-sdk/protocol';

import { readTriageActions, triageActionDeliveryForLaunchModeV1, type TriageActionCommandV1 } from '../settings/actions.js';
import type { TriageActionsCatalogDepsV1 } from './actionsCatalog.js';
import { saveTriageActionDefaultProfileV1 } from './actionDefaultsProfile.js';
import { readTriageActionDirectoryRefusalV1 } from '../sessions/actionLaunch.js';

type Preparation =
    | Readonly<{ command: TriageActionCommandV1 }>
    | Readonly<{ status: 'unknownAction' | 'unreadable' }>
    | Readonly<{ status: 'rejected'; reason: 'target' | typeof TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 }>;

/** Snapshot composer authoring through the incumbent prompt and Profile owners.
 * The catalog retains references only; shared source records are never edited. */
export async function prepareTriageActionDefaultsV1(
    input: TriageSaveActionDefaultsInputV1,
    deps: TriageActionsCatalogDepsV1,
): Promise<Preparation> {
    const current = await readTriageActions(deps);
    if (current.kind === 'unreadable') return { status: 'unreadable' };
    const action = current.value.actions.find(candidate => candidate.actionId === input.actionId);
    if (!action) return { status: 'unknownAction' };
    if (action.target.kind !== 'agent') return { status: 'rejected', reason: 'target' };
    const directoryRefusal = readTriageActionDirectoryRefusalV1(action.workspaceMode,
        resolveLaunchProfilePlacementDirectoryIntentV1(input.placement));
    if (directoryRefusal) return { status: 'rejected', reason: directoryRefusal };
    const actions = deps.actions;
    if (!actions) throw new PluginError({ code: 'plugin_action_unavailable' });
    const options = deps.signal ? { signal: deps.signal } : undefined;
    const saved = action.savedDefaults;
    const profile = await saveTriageActionDefaultProfileV1({
        profileId: input.profileId, placement: input.placement, checkout: input.checkout,
        ...(saved ? { ownedProfileId: saved.profileId, sourceProfileId: saved.sourceProfileId } : {}),
    }, { actions, mintId: deps.mintActionId, ...(deps.signal ? { signal: deps.signal } : {}) });

    let promptDocumentId: string;
    let promptInvocationId: string;
    if (saved && saved.promptInvocationId === action.target.promptInvocationId) {
        promptDocumentId = saved.promptDocumentId;
        promptInvocationId = saved.promptInvocationId;
        const document = await actions.execute('prompt_doc.get', { artifactId: promptDocumentId }, options);
        if (isPluginActionApprovalRequestCreated(document)) throw new PluginError({ code: 'approval_required' });
        const written = await actions.execute('prompt_doc.update', { artifactId: promptDocumentId,
            title: input.label, markdown: input.promptText, expectedRevision: document.revision }, options);
        if (isPluginActionApprovalRequestCreated(written)) throw new PluginError({ code: 'approval_required' });
    } else {
        const document = await actions.execute('prompt_doc.create', { title: input.label, markdown: input.promptText }, options);
        if (isPluginActionApprovalRequestCreated(document)) throw new PluginError({ code: 'approval_required' });
        promptDocumentId = document.artifactId;
        const invocation = await actions.execute('prompts.invocation.create', {
            token: `/action-${deps.mintActionId()}`, title: input.label,
            target: { kind: 'doc', artifactId: promptDocumentId }, allowArgs: false,
        }, options);
        if (isPluginActionApprovalRequestCreated(invocation)) throw new PluginError({ code: 'approval_required' });
        if (invocation.status !== 'updated') throw new PluginError({
            code: 'reason' in invocation ? invocation.reason : invocation.status,
            details: { actionId: 'prompts.invocation.create', status: invocation.status },
        });
        promptInvocationId = invocation.invocationId;
    }
    return { command: {
        kind: 'update', actionId: action.actionId, expectedRevision: current.revision,
        label: input.label, enabled: action.enabled, appliesTo: action.appliesTo, workspaceMode: action.workspaceMode,
        profileId: profile.profileId,
        target: { kind: 'agent', promptInvocationId, delivery: triageActionDeliveryForLaunchModeV1(input.launchMode) },
        savedDefaults: { promptDocumentId, promptInvocationId, profileId: profile.profileId, sourceProfileId: profile.sourceProfileId },
    } };
}

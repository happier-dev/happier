import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    HostPrivatePluginInstallDecisionV1Schema,
} from '@happier-dev/protocol/marketplace/internal';

/**
 * @template T
 * @param {{
 *   pendingChangeId: string;
 *   isAuthorityCurrent: () => boolean | Promise<boolean>;
 *   callAuthenticatedPrivateRpc: (method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD, payload: import('@happier-dev/protocol/marketplace/internal').HostPrivatePluginInstallDecisionV1) => Promise<T>;
 * }} params
 * @param {(() => Record<string, unknown>) | null} buildAffirmative
 *   Deferred on purpose: actor evidence is minted only after the authority
 *   recheck below, so a decision abandoned mid-confirmation leaves no evidence
 *   of an interaction that never authorized anything.
 * @returns {Promise<T>}
 */
async function sendPresentUserDecision(params, buildAffirmative) {
    if (!await params.isAuthorityCurrent()) {
        throw new Error('Authenticated plugin install authority changed during present-user confirmation');
    }

    const payload = HostPrivatePluginInstallDecisionV1Schema.parse(buildAffirmative !== null
        ? buildAffirmative()
        : {
            v: 1,
            pendingChangeId: params.pendingChangeId,
            decision: 'cancel',
        });

    return await params.callAuthenticatedPrivateRpc(
        HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
        payload,
    );
}

/**
 * Canonical present-user boundary for affirmative private install decisions.
 *
 * UI confirmation and authenticated transport stay injected so composed tests can exercise
 * this exact boundary without recreating actor evidence or exposing a public decision command.
 *
 * @template T
 * @param {{
 *   pendingChangeId: string;
 *   confirmPresentUser: () => Promise<ReadonlyArray<{ accessId: string; selected: boolean }> | null>;
 *   isAuthorityCurrent: () => boolean | Promise<boolean>;
 *   callAuthenticatedPrivateRpc: (method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD, payload: import('@happier-dev/protocol/marketplace/internal').HostPrivatePluginInstallDecisionV1) => Promise<T>;
 *   createInteractionId: () => string;
 *   nowMs: () => number;
 * }} params
 * @returns {Promise<T>}
 */
export async function decideMachinePluginInstallReviewAsPresentUser(params) {
    const optionalSelections = await params.confirmPresentUser();
    return await sendPresentUserDecision(params, optionalSelections !== null
        ? () => ({
            v: 1,
            pendingChangeId: params.pendingChangeId,
            decision: 'installAndTrust',
            actorEvidence: {
                kind: 'authenticatedLocalUser',
                interactionId: params.createInteractionId(),
                occurredAtMs: params.nowMs(),
            },
            optionalSelections,
        })
        : null);
}

/**
 * Canonical present-user boundary for authorizing a **local development source
 * root**. It shares this module's actor evidence, authority recheck, schema and
 * transport with the install decision rather than growing a second private
 * decision path, but it is a genuinely different authorization: it grants no
 * optional host access and commits no plugin — it only lets the daemon evaluate
 * executable code from the exact root the user was shown.
 *
 * @template T
 * @param {{
 *   pendingChangeId: string;
 *   confirmPresentUser: () => Promise<boolean>;
 *   isAuthorityCurrent: () => boolean | Promise<boolean>;
 *   callAuthenticatedPrivateRpc: (method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD, payload: import('@happier-dev/protocol/marketplace/internal').HostPrivatePluginInstallDecisionV1) => Promise<T>;
 *   createInteractionId: () => string;
 *   nowMs: () => number;
 * }} params
 * @returns {Promise<T>}
 */
export async function decideMachinePluginDevelopmentSourceRootAsPresentUser(params) {
    const approved = await params.confirmPresentUser();
    return await sendPresentUserDecision(params, approved === true
        ? () => ({
            v: 1,
            pendingChangeId: params.pendingChangeId,
            decision: 'trustSourceRoot',
            actorEvidence: {
                kind: 'authenticatedLocalUser',
                interactionId: params.createInteractionId(),
                occurredAtMs: params.nowMs(),
            },
        })
        : null);
}

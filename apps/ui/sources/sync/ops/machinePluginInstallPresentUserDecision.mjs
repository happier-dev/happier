import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    HostPrivatePluginInstallDecisionV1Schema,
} from '@happier-dev/protocol/marketplace/internal';

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
    if (!await params.isAuthorityCurrent()) {
        throw new Error('Authenticated plugin install authority changed during present-user confirmation');
    }

    const payload = HostPrivatePluginInstallDecisionV1Schema.parse(optionalSelections !== null
        ? {
            v: 1,
            pendingChangeId: params.pendingChangeId,
            decision: 'installAndTrust',
            actorEvidence: {
                kind: 'authenticatedLocalUser',
                interactionId: params.createInteractionId(),
                occurredAtMs: params.nowMs(),
            },
            optionalSelections,
        }
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

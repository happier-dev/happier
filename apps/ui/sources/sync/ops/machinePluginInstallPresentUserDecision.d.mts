import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    type HostPrivatePluginInstallDecisionV1,
} from '@happier-dev/protocol/marketplace/internal';

type AffirmativeDecision = Extract<
    HostPrivatePluginInstallDecisionV1,
    Readonly<{ decision: 'installAndTrust' }>
>;
type OptionalSelection = NonNullable<AffirmativeDecision['optionalSelections']>[number];

export declare function decideMachinePluginInstallReviewAsPresentUser<T>(params: Readonly<{
    pendingChangeId: string;
    confirmPresentUser: () => Promise<readonly Readonly<OptionalSelection>[] | null>;
    isAuthorityCurrent: () => boolean | Promise<boolean>;
    callAuthenticatedPrivateRpc: (
        method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
        payload: HostPrivatePluginInstallDecisionV1,
    ) => Promise<T>;
    createInteractionId: () => string;
    nowMs: () => number;
}>): Promise<T>;

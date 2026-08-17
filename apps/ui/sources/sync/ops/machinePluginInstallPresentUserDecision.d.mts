import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    type HostPrivatePluginInstallDecisionV1,
} from '@happier-dev/protocol/marketplace/internal';

type AffirmativeDecision = Extract<
    HostPrivatePluginInstallDecisionV1,
    Readonly<{ decision: 'installAndTrust' }>
>;
type OptionalSelection = NonNullable<AffirmativeDecision['optionalSelections']>[number];

type PresentUserDecisionTransport<T> = Readonly<{
    pendingChangeId: string;
    isAuthorityCurrent: () => boolean | Promise<boolean>;
    callAuthenticatedPrivateRpc: (
        method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
        payload: HostPrivatePluginInstallDecisionV1,
    ) => Promise<T>;
    createInteractionId: () => string;
    nowMs: () => number;
}>;

export declare function decideMachinePluginInstallReviewAsPresentUser<T>(
    params: PresentUserDecisionTransport<T> & Readonly<{
        confirmPresentUser: () => Promise<readonly Readonly<OptionalSelection>[] | null>;
    }>,
): Promise<T>;

export declare function decideMachinePluginDevelopmentSourceRootAsPresentUser<T>(
    params: PresentUserDecisionTransport<T> & Readonly<{
        confirmPresentUser: () => Promise<boolean>;
    }>,
): Promise<T>;

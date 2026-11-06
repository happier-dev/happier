import type { MachineProvisionersService } from '../services/machineProvisioners.js';
import type { HttpService } from '../services/io.js';
import type { MachineConnectorSecretsService, SecretsService } from '../secrets.js';
import type { ConnectedAccountsService } from '../connectedAccounts.js';
import type { CurrentUiContextSnapshotV1, PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    JsonValue,
    PluginContributionRef,
    PluginIdentity,
    PluginInvocationContributionIdentity,
} from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { PluginEphemeralSharedScope } from '../ephemeralSharedScope.js';
import type { PluginUiHostApi } from '../ui/hostApi.js';
import type { PluginActionContributionV2 } from './actionTypeMap.generated.js';
import type { ActionsService } from './service.js';
import type { PluginAccountStorageScope } from '../storage.js';
import type { TargetedContributionsService } from '../services/targetedContributions.js';
import type { PluginActionReadObserver as RegistrationActionReadObserver } from '@happier-dev/cli-common/plugins/registration/contracts';
export type { PluginActionReadInvalidation } from '@happier-dev/cli-common/plugins/registration/contracts';

export type PluginActionReadObserver<I extends JsonValue = JsonValue, TContext = PluginInvocationContext> = RegistrationActionReadObserver<I, TContext>;
import type { ScopedSettingsService } from '../services/core.js';

/**
 * A contributed Action's qualified runtime identity plus declaration-only
 * input/result inference. The runtime value still contains only `pluginId`
 * and `localId`; `typeProjection` is required structurally so independently
 * installed SDK copies preserve the producer's types without carrying a
 * schema, parser, handler, or other implementation value.
 */
export type ActionContract<
    TInput extends JsonValue = JsonValue,
    TResult extends JsonValue | void = JsonValue | void,
> = PluginContributionRef & Readonly<{
    typeProjection: Readonly<{
        input: TInput;
        result: TResult;
    }> | undefined;
}>;

/** One manifest-declared Action invocation surface, generated from Protocol. */
export type PluginActionInvocationSurfaceV2 = PluginActionContributionV2['surfaces'][number];

/** The bounded UI capability available to client-targeted Action handlers. */
export type PluginClientActionUi = Readonly<{
    version: PluginUiHostApi['version'];
    /** Exact current contributions and admitted Account identity; no UI mount is implied. */
    context(options?: Parameters<PluginUiHostApi['context']>[0]): Promise<Readonly<Pick<
        Awaited<ReturnType<PluginUiHostApi['context']>>, 'accountScope'> & {
        targetedContributions: PluginUiTargetedContributionsV1 | null;
    }>>;
    selectActionInput: PluginUiHostApi['selectActionInput'];
    executeAction: PluginUiHostApi['executeAction'];
    openSurface: PluginUiHostApi['openSurface'];
    openNewSession: PluginUiHostApi['openNewSession'];
    openAutomationEvent: PluginUiHostApi['openAutomationEvent'];
    revealSessionInput: PluginUiHostApi['revealSessionInput'];
}>;

/**
 * The whole client-side capability set for one Action invocation.
 * @realm client
 */
export type PluginClientActionContext = Readonly<{
    plugin: PluginIdentity;
    contribution: PluginInvocationContributionIdentity;
    invocationSurface: PluginActionInvocationSurfaceV2;
    signal: AbortSignal;
    ui: PluginClientActionUi;
    /** Same Account/plugin/immutable-generation scope as mounted UI artifacts. */
    ephemeralSharedScope: PluginEphemeralSharedScope | null;
    currentUiContext?: CurrentUiContextSnapshotV1;
    /** Same bounded host-resolved snapshot as daemon Actions; absent outside a message menu. */
    messageAction?: PluginInvocationContext['messageAction'];
}>;

/** Portable invocation capabilities; no Machine or native process capability is implied. @realm any */
export type PluginAccountActionContext = Readonly<{
    plugin: PluginIdentity;
    contribution: PluginInvocationContributionIdentity;
    surface: PluginInvocationContext['surface'];
    invokedAtMs: number;
    caller?: PluginInvocationContext['caller'];
    signal: AbortSignal;
    /** Authenticated invoking Account, never derived from Action input. */
    accountScope?: Awaited<ReturnType<PluginClientActionUi['context']>>['accountScope'];
    /** Present only when this invocation has ordinary client authoring capability. */
    ui?: PluginClientActionUi;
    services: Readonly<{
        /** Privately admitted managed-resource byte custody; native file APIs may be unavailable. */
        machineProvisioners: MachineProvisionersService;
        machineConnectorSecrets?: MachineConnectorSecretsService;
        /** Host HTTP with credential-scoped redirects and invocation cancellation. */
        http: HttpService;
        /** Selected Account Saved Secret custody; native-only material remains unavailable. */
        secrets: SecretsService;
        /** Exact purpose-bound Account materialization; no native credential fallback. */
        connectedAccounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize' | 'listAccounts' | 'materializeListedAccount'>;
        storage: Readonly<{ account: PluginAccountStorageScope }>;
        /** Declaration-bound Account reads; mutation remains with the Settings Actions. */
        settings: Readonly<{
            forScope: (scope: Readonly<{ kind: 'account' }>) => Pick<ScopedSettingsService, 'snapshot' | 'get' | 'describe' | 'watch'>;
        }>;
        actions: Pick<ActionsService, 'execute' | 'observe' | 'executeAdmittedTargetedOperation' | 'observeAdmittedTargetedOperation'>;
        targetedContributions: TargetedContributionsService;
    }>;
}>;

/** @realm any */
export type PluginAccountActionHandler<
    I extends JsonValue = JsonValue,
    O extends JsonValue | void = JsonValue | void,
> = (input: I, context: PluginAccountActionContext) => O | Promise<O>;

/** Handler for one daemon-targeted manifest Action contribution. */
export type ActionHandler<
    I extends JsonValue = JsonValue,
    O extends JsonValue | void = JsonValue | void,
> = (input: I, context: PluginInvocationContext) => O | Promise<O>;

/** Handler for one client-targeted manifest Action contribution. */
export type PluginClientActionHandler<
    I extends JsonValue = JsonValue,
    O extends JsonValue | void = JsonValue | void,
> = (input: I, context: PluginClientActionContext) => O | Promise<O>;

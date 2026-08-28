import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    JsonValue,
    PluginContributionRef,
    PluginIdentity,
    PluginInvocationContributionIdentity,
} from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { PluginUiHostApi } from '../ui/hostApi.js';
import type { PluginActionContributionV2 } from './actionTypeMap.generated.js';

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
    openSurface: PluginUiHostApi['openSurface'];
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
    currentUiContext?: CurrentUiContextSnapshotV1;
}>;

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

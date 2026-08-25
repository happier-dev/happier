import * as React from 'react';

import {
    arePluginMachineExecutionOriginsEqual,
    formatQualifiedPluginActionId,
    type ActionDefinitionV1,
    type PluginContributionIdentityV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import type {
    PluginUiHostApiErrorCodeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import {
    usePluginSurfaceDestinationNavigationBinding,
    type PluginSurfaceDestinationNavigationBinding,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    dispatchPluginSurfaceAction,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginActionCurrentIntentHandler,
} from '@/components/plugins/surfaces/pluginSurfaceFeedback';
import {
    createPluginUiProjectedActionResolver,
    isPluginProjectedActionExecutable,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import {
    readPluginUiContributionOrigin,
    type PluginUiContributionOriginV1,
} from '@/sync/domains/plugins/ui/projectionUnion';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { getPreferredLanguage } from '@/text';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import {
    useOptionalCurrentUiContextReader,
    type CurrentUiContextReader,
    type CurrentUiContextResolvedCommand,
} from './CurrentUiContextProvider';

/**
 * The bounded settlement that the current-UI owner can give a Voice effect.
 * It deliberately omits the resolved semantic command, its input, and host
 * diagnostics: those remain local to the current-context and Action owners.
 */
export type CurrentUiContextVoiceInvocationOutcome =
    | Readonly<{ ok: true; result?: PluginUiJsonValueV1 }>
    | Readonly<{ ok: false; code: PluginUiHostApiErrorCodeV1 | 'outcome_unknown' }>;

export type CurrentUiContextVoiceCommandInvocationInput = Readonly<{
    commandId: string;
    signal?: AbortSignal;
}>;

export type CurrentUiContextVoiceActionInvocationInput = Readonly<{
    action: PluginContributionIdentityV1;
    input?: PluginUiJsonValueV1;
    signal?: AbortSignal;
}>;

/**
 * The client-local current-context port carried into a Voice attempt. The
 * reader is sufficient for explicit reads; the optional effect members are
 * supplied only by the AppShell bridge that can delegate to the incumbent
 * navigation and Action owners. No consumer can recover semantic payloads
 * from an opaque command ID through this type.
 */
export type CurrentUiContextVoiceToolPort = CurrentUiContextReader & Readonly<{
    listCurrentContributedActionDefinitions?: () => readonly ActionDefinitionV1[];
    invokeCurrentUiCommand?: (
        input: CurrentUiContextVoiceCommandInvocationInput,
    ) => Promise<CurrentUiContextVoiceInvocationOutcome>;
    invokeAction?: (
        input: CurrentUiContextVoiceActionInvocationInput,
    ) => Promise<CurrentUiContextVoiceInvocationOutcome>;
}>;

type CurrentUiContextVoiceToolPortInput = Readonly<{
    reader: CurrentUiContextReader;
    /** Reads the latest AppShell projection at an effect boundary. */
    readProjection: () => PluginUiProjectionModel | null;
    /** Reads the incumbent app-target navigation binding at an effect boundary. */
    readNavigationBinding: () => PluginSurfaceDestinationNavigationBinding | null;
}>;

function unavailable(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'unavailable' };
}

/**
 * Narrows a stable current-UI port to one already-admitted Voice lifetime.
 * The AppShell port intentionally follows current refs while the attempt is
 * live; a capture that retires must instead stop reading or affecting a later
 * Account/client render. This wrapper adds no snapshot/cache or effect owner:
 * it only propagates that exact admission's existing cancellation signal into
 * the canonical reader and invocation boundaries.
 */
export function bindCurrentUiContextVoiceToolPortToAdmission(
    port: CurrentUiContextVoiceToolPort,
    admissionRetirementSignal: AbortSignal,
): CurrentUiContextVoiceToolPort {
    const isCurrent = (): boolean => !admissionRetirementSignal.aborted;
    const sourceInvokeCurrentUiCommand = port.invokeCurrentUiCommand;
    const invokeCurrentUiCommand = sourceInvokeCurrentUiCommand
        ? async (
            request: CurrentUiContextVoiceCommandInvocationInput,
        ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
            if (!isCurrent()) return unavailable();
            const merged = mergeAbortSignals([admissionRetirementSignal, request.signal]);
            try {
                if (merged.signal.aborted) return unavailable();
                // The wrapped AppShell port remains the sole effect/currentness
                // owner. In particular, preserve a result it has already
                // settled even if this admission retires before the await ends.
                return await sourceInvokeCurrentUiCommand({ ...request, signal: merged.signal });
            } finally {
                merged.dispose();
            }
        }
        : undefined;
    const sourceInvokeAction = port.invokeAction;
    const invokeAction = sourceInvokeAction
        ? async (
            request: CurrentUiContextVoiceActionInvocationInput,
        ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
            if (!isCurrent()) return unavailable();
            const merged = mergeAbortSignals([admissionRetirementSignal, request.signal]);
            try {
                if (merged.signal.aborted) return unavailable();
                return await sourceInvokeAction({ ...request, signal: merged.signal });
            } finally {
                merged.dispose();
            }
        }
        : undefined;

    return Object.freeze({
        ...port,
        readCurrentUiContext: () => isCurrent() ? port.readCurrentUiContext() : null,
        resolveCurrentUiCommand: (commandId) => isCurrent()
            ? port.resolveCurrentUiCommand(commandId)
            : null,
        subscribe: (listener) => {
            if (!isCurrent()) return () => {};
            let unsubscribed = false;
            let unsubscribe = () => {};
            const release = () => {
                if (unsubscribed) return;
                unsubscribed = true;
                admissionRetirementSignal.removeEventListener('abort', release);
                unsubscribe();
            };
            unsubscribe = port.subscribe(() => {
                if (isCurrent()) listener();
            });
            admissionRetirementSignal.addEventListener('abort', release, { once: true });
            if (!isCurrent()) release();
            return release;
        },
        ...(port.listCurrentContributedActionDefinitions
            ? {
                listCurrentContributedActionDefinitions: () => isCurrent()
                    ? port.listCurrentContributedActionDefinitions!()
                    : [],
            }
            : {}),
        ...(invokeCurrentUiCommand ? { invokeCurrentUiCommand } : {}),
        ...(invokeAction ? { invokeAction } : {}),
    });
}

function stale(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'stale_surface' };
}

function internalError(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'internal_error' };
}

function actionSideEffectClass(
    dangerLevel: PluginProjectedActionV2['dangerLevel'],
): ActionDefinitionV1['sideEffectClass'] {
    switch (dangerLevel) {
        case 'safe':
            return undefined;
        case 'writesLocal':
        case 'writesRemote':
            return 'write';
        case 'externalSideEffect':
            return 'external';
        case 'destructive':
            return 'danger';
    }
}

function projectedActionToDefinition(
    action: PluginProjectedActionV2,
    projection: PluginUiProjectionModel,
): ActionDefinitionV1 {
    const presentation = resolvePluginProjectedActionPresentation({
        pluginId: action.pluginId,
        presentation: action,
        projection,
        locale: getPreferredLanguage(),
    });
    const sideEffectClass = actionSideEffectClass(action.dangerLevel);
    const approval: NonNullable<ActionDefinitionV1['approval']> = action.dangerLevel === 'safe'
        ? { result: 'none' }
        : { result: 'required', flow: 'blocking' };
    return Object.freeze({
        kindVersion: 1,
        id: formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.id }),
        title: presentation.title,
        description: presentation.description,
        safety: action.dangerLevel === 'safe' ? 'safe' : 'danger',
        approval,
        placements: [],
        slash: action.slash ?? null,
        bindings: null,
        examples: null,
        surfaces: {
            ui: action.surfaces.includes('ui'),
            voice: action.surfaces.includes('voice'),
            agent: action.surfaces.includes('agent'),
            mcp: action.surfaces.includes('mcp'),
            cli: action.surfaces.includes('cli'),
            rpc: false,
            api: false,
            plugin: action.surfaces.includes('plugin'),
        },
        inputHints: presentation.inputHints,
        inputSchema: action.inputSchema ?? {},
        ...(action.outputSchema ? { outputSchema: action.outputSchema } : {}),
        ...(sideEffectClass ? { sideEffectClass } : {}),
    });
}

function listCurrentContributedActionDefinitions(
    readProjection: () => PluginUiProjectionModel | null,
): readonly ActionDefinitionV1[] {
    const projection = readProjection();
    if (!projection) return [];
    const readSnapshot = () => projection;
    return Object.values(projection.actionsById)
        .filter((action) => {
            if (!isPluginProjectedActionExecutable(action) || !action.surfaces.includes('voice')) return false;
            const resolved = resolveCurrentAction(readSnapshot, {
                pluginId: action.pluginId,
                localId: action.id,
            });
            return resolved?.action === action
                && hasCurrentClientActionRegistration(resolved);
        })
        .map((action) => projectedActionToDefinition(action, projection))
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The opaque ID is valid only while this exact private command record remains
 * the provider-local current record. It is deliberately a data/currentness
 * comparison, never a retained callback or an independently-owned registry.
 */
function isResolvedCommandCurrent(
    reader: CurrentUiContextReader,
    resolved: CurrentUiContextResolvedCommand,
): boolean {
    const current = reader.resolveCurrentUiCommand(resolved.id);
    return current !== null
        && current.id === resolved.id
        && current.command === resolved.command;
}

type CurrentUiContextVoiceActionOrigin = Readonly<
    Omit<PluginUiContributionOriginV1, 'generation'> & Readonly<{ generation: number }>
>;

type CurrentUiContextVoiceResolvedAction = Readonly<{
    action: PluginProjectedActionV2;
    origin: CurrentUiContextVoiceActionOrigin;
}>;

/**
 * Actions remain projection-owned facts. The Voice bridge only admits an exact
 * current origin that can be used by the shared dispatcher; it does not infer
 * target availability, materialize a client Action, or retain an old lookup.
 */
function resolveCurrentAction(
    readProjection: () => PluginUiProjectionModel | null,
    identity: PluginContributionIdentityV1,
): CurrentUiContextVoiceResolvedAction | null {
    const action = createPluginUiProjectedActionResolver(readProjection()?.actionsById)(identity);
    const origin = action ? readPluginUiContributionOrigin(action) : null;
    if (
        !action
        || !origin
        || origin.phase !== 'current'
        || origin.interactionEnabled !== true
    ) {
        return null;
    }
    const generation = origin.generation;
    if (
        typeof generation !== 'number'
        || !Number.isInteger(generation)
        || generation < 0
    ) {
        return null;
    }
    return Object.freeze({
        action,
        origin: Object.freeze({ ...origin, generation }),
    });
}

/**
 * Client Actions become discoverable only after the one generic executable
 * composition has committed their exact target, origin, and generation.
 * Daemon Actions retain the dispatcher-owned availability path.
 */
function hasCurrentClientActionRegistration(
    resolved: CurrentUiContextVoiceResolvedAction,
): boolean {
    const { action, origin } = resolved;
    if (action.execution.target !== 'client') return true;
    return resolvePluginUiClientActionRegistration({
        action,
        projectionGeneration: origin.generation,
        platform: resolvePluginUiClientExecutablePlatform(),
    }) !== null;
}

function isResolvedActionCurrent(
    readProjection: () => PluginUiProjectionModel | null,
    identity: PluginContributionIdentityV1,
    resolved: CurrentUiContextVoiceResolvedAction,
): boolean {
    const current = resolveCurrentAction(readProjection, identity);
    return current !== null
        && current.action === resolved.action
        && current.origin.machineId === resolved.origin.machineId
        && current.origin.serverId === resolved.origin.serverId
        && current.origin.generation === resolved.origin.generation
        && (
            current.origin.executionOrigin === resolved.origin.executionOrigin
            || (
                current.origin.executionOrigin !== null
                && resolved.origin.executionOrigin !== null
                && arePluginMachineExecutionOriginsEqual(
                    current.origin.executionOrigin,
                    resolved.origin.executionOrigin,
                )
            )
        )
        && hasCurrentClientActionRegistration(current);
}

/**
 * AppShell-side bridge for the provider-local current-context reader. It owns
 * no navigation state or Action policy: opaque commands are re-resolved at the
 * reader and then delegated to the incumbent navigation/Action owners.
 */
export function createCurrentUiContextVoiceToolPort(
    input: CurrentUiContextVoiceToolPortInput,
): CurrentUiContextVoiceToolPort {
    const invokeProjectedAction = async (
        request: CurrentUiContextVoiceActionInvocationInput,
        isCallerCurrent: () => boolean,
        includeCurrentUiContext: boolean,
    ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
        if (request.signal?.aborted) return unavailable();
        const resolved = resolveCurrentAction(input.readProjection, request.action);
        if (!resolved || !hasCurrentClientActionRegistration(resolved)) return unavailable();
        const isCurrent = (): boolean => (
            request.signal?.aborted !== true
            && isCallerCurrent()
            && isResolvedActionCurrent(input.readProjection, request.action, resolved)
        );
        if (!isCurrent()) return stale();
        const requestCurrentIntent = resolved.action.execution.target === 'client'
            ? createPluginActionCurrentIntentHandler({
                requester: {
                    pluginId: resolved.action.pluginId,
                    contributionId: resolved.action.id,
                    generationId: String(resolved.origin.generation),
                    invocationId: `voice-action:${resolved.origin.generation}`,
                },
                signal: request.signal ?? new AbortController().signal,
                isCurrent,
                pluginUiProjection: input.readProjection(),
            })
            : undefined;

        const openSurface = async (surfaceRequest: Parameters<PluginSurfaceDestinationNavigationBinding['openSurface']>[0]) => {
            if (!isCurrent()) {
                return { ok: false as const, code: 'stale_surface' as const, reason: 'current_ui_action_retired' };
            }
            const navigation = input.readNavigationBinding();
            if (!navigation) {
                return { ok: false as const, code: 'unavailable' as const, reason: 'current_ui_navigation_unavailable' };
            }
            if (!isCurrent()) {
                return { ok: false as const, code: 'stale_surface' as const, reason: 'current_ui_action_retired' };
            }
            try {
                const outcome = await navigation.openSurface(surfaceRequest);
                return outcome;
            } catch {
                return isCurrent()
                    ? { ok: false as const, code: 'internal_error' as const, reason: 'current_ui_navigation_failed' }
                    : { ok: false as const, code: 'stale_surface' as const, reason: 'current_ui_action_retired' };
            }
        };
        try {
            const outcome = await dispatchPluginSurfaceAction({
                action: request.action,
                ...(request.input === undefined ? {} : { input: request.input }),
                resolveContributedAction: (identity) => (
                    createPluginUiProjectedActionResolver(input.readProjection()?.actionsById)(identity)
                ),
                invocationSurface: 'voice',
                clientAction: {
                    projectionGeneration: resolved.origin.generation,
                    openSurface,
                    ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
                    ...(includeCurrentUiContext
                        ? {
                            currentUiContext: () => isCurrent()
                                ? input.reader.readCurrentUiContext()
                                : null,
                        }
                        : {}),
                },
                ...(resolved.action.execution.target === 'daemon'
                    ? {
                        contributedAction: {
                            machineId: resolved.origin.machineId,
                            serverId: resolved.origin.serverId,
                            expectedGeneration: String(resolved.origin.generation),
                        },
                    }
                    : {}),
                signal: request.signal,
                isCurrent,
            });
            if (outcome.ok) return { ok: true, result: outcome.result };
            if (outcome.reason === 'plugin_ui_action_outcome_unknown') {
                // An issued effect remains indeterminate even if its UI binding
                // retired while the acknowledgement was lost. Voice custody
                // retains this canonical terminal result by stable effect ID.
                return { ok: false, code: 'outcome_unknown' };
            }
            return { ok: false, code: outcome.code };
        } catch {
            return isCurrent() ? internalError() : stale();
        }
    };

    const invokeAction = async (
        request: CurrentUiContextVoiceActionInvocationInput,
    ): Promise<CurrentUiContextVoiceInvocationOutcome> => (
        invokeProjectedAction(request, () => true, false)
    );

    const invokeCurrentUiCommand = async (
        request: CurrentUiContextVoiceCommandInvocationInput,
    ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
        if (request.signal?.aborted) return unavailable();
        const resolved = input.reader.resolveCurrentUiCommand(request.commandId);
        if (!resolved) return unavailable();
        const isCurrent = (): boolean => (
            request.signal?.aborted !== true
            && isResolvedCommandCurrent(input.reader, resolved)
        );
        if (!isCurrent()) return stale();

        if (resolved.command.kind === 'executeAction') {
            const mergedSignal = mergeAbortSignals([resolved.retirementSignal, request.signal]);
            try {
                return await invokeProjectedAction({
                    action: resolved.command.action,
                    ...(resolved.command.input === undefined ? {} : { input: resolved.command.input }),
                    signal: mergedSignal.signal,
                }, isCurrent, true);
            } finally {
                mergedSignal.dispose();
            }
        }

        const navigation = input.readNavigationBinding();
        if (!navigation) return unavailable();
        // The binding lookup itself can cross a render/currentness boundary;
        // the final re-resolution is immediately before the outward effect.
        if (!isCurrent()) return stale();
        try {
            const outcome = await navigation.openSurface({
                destination: resolved.command.destination,
                ...(resolved.command.input === undefined ? {} : { input: resolved.command.input }),
                ...(resolved.command.subPath === undefined ? {} : { subPath: resolved.command.subPath }),
                ...(resolved.command.instanceKey === undefined ? {} : { instanceKey: resolved.command.instanceKey }),
            });
            // A known success remains authoritative even if the publishing
            // mount retires while navigation settles. The same holds for a
            // known failure: rewriting either result would make the incumbent
            // Voice barrier invite a blind retry.
            if (outcome.ok) return { ok: true };
            return { ok: false, code: outcome.code };
        } catch {
            return isCurrent() ? { ok: false, code: 'internal_error' } : stale();
        }
    };

    return Object.freeze({
        ...input.reader,
        listCurrentContributedActionDefinitions: () => (
            listCurrentContributedActionDefinitions(input.readProjection)
        ),
        invokeCurrentUiCommand,
        invokeAction,
    });
}

/**
 * The stable attempt-local port follows current AppShell facts through refs,
 * so an already-created Voice attempt cannot recover a retired projection or
 * navigation binding from a prior render. No global store or callback registry
 * is introduced.
 */
export function useCurrentUiContextVoiceToolPort(): CurrentUiContextVoiceToolPort | null {
    const reader = useOptionalCurrentUiContextReader();
    const appShellProjection = useAppShellPluginUiProjection();
    const navigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const projectionRef = React.useRef(appShellProjection.pluginUiProjection);
    const navigationBindingRef = React.useRef(navigationBinding);
    projectionRef.current = appShellProjection.pluginUiProjection;
    navigationBindingRef.current = navigationBinding;

    return React.useMemo(
        () => reader
            ? createCurrentUiContextVoiceToolPort({
                reader,
                readProjection: () => projectionRef.current,
                readNavigationBinding: () => navigationBindingRef.current,
            })
            : null,
        [reader],
    );
}

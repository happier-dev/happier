import * as React from 'react';

import {
    arePluginMachineExecutionOriginsEqual,
    buildQualifiedPluginContributionKey,
    formatQualifiedPluginActionId,
    parseQualifiedPluginActionId,
    UiContributedActionExecuteRequestV1Schema,
    UiContributedActionExecuteResponseV1Schema,
    PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE,
    type ActionDefinitionSummaryV1,
    type PluginContributionIdentityV1,
    type PluginJsonSchemaV2,
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
    type PluginSurfaceHostActionBinding,
    type PluginSurfaceHostActionExecute,
    type PluginSurfaceActionInvocationSurface,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
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
import { machinePluginActionSchemasRead } from '@/sync/ops/machineContributionRegistryProjection';
import { getPreferredLanguage } from '@/text';
import { registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { unavailable } from './currentUiContextVoiceToolBinding';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
export { bindCurrentUiContextVoiceToolPortToAdmission } from './currentUiContextVoiceToolBinding';

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
    | Readonly<{ ok: false; code: PluginUiHostApiErrorCodeV1 | 'outcome_unknown'; errorCode?: string; actionHandlerInvocation?: 'notStarted' }>;

export type CurrentUiContextVoiceCommandInvocationInput = Readonly<{
    commandId: string;
    signal?: AbortSignal;
}>;

export type CurrentUiContextVoiceActionInvocationInput = Readonly<{
    action: PluginContributionIdentityV1;
    input?: PluginUiJsonValueV1;
    signal?: AbortSignal;
    expectedContributorOccurrenceId?: string;
    defaultSessionId?: string;
    requiredDangerLevel?: 'safe';
}>;

/**
 * The client-local current-context port carried into a Voice attempt. The
 * reader is sufficient for explicit reads; the optional effect members are
 * supplied only by the AppShell bridge that can delegate to the incumbent
 * navigation and Action owners. No consumer can recover semantic payloads
 * from an opaque command ID through this type.
 */
/** One contributed Action's declared schemas, read on demand (never listed). */
export type CurrentUiContextVoiceActionSchemas = Readonly<{
    inputSchema: PluginJsonSchemaV2;
    outputSchema?: PluginJsonSchemaV2;
}>;

export type CurrentUiContextVoiceToolPort = CurrentUiContextReader & Readonly<{
    listCurrentContributedActionDefinitions?: () => readonly ActionDefinitionSummaryV1[];
    readCurrentContributedActionSchemas?: (
        id: string,
        signal?: AbortSignal,
    ) => Promise<CurrentUiContextVoiceActionSchemas | null>;
    invokeCurrentUiCommand?: (
        input: CurrentUiContextVoiceCommandInvocationInput,
    ) => Promise<CurrentUiContextVoiceInvocationOutcome>;
    invokeAction?: (
        input: CurrentUiContextVoiceActionInvocationInput,
    ) => Promise<CurrentUiContextVoiceInvocationOutcome>;
}>;

type CurrentUiContextVoiceToolPortInput = Readonly<{
    /** Voice callers omit this; ordinary host Actions retain their real surface. */
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    hostAction?: PluginSurfaceHostActionBinding;
    reader: CurrentUiContextReader;
    /** Reads the latest AppShell projection at an effect boundary. */
    readProjection: () => PluginUiProjectionModel | null;
    /** Reads the incumbent app-target navigation binding at an effect boundary. */
    readNavigationBinding: () => PluginSurfaceDestinationNavigationBinding | null;
}>;

function stale(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'stale_surface' };
}

function internalError(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'internal_error' };
}

function actionSideEffectClass(
    dangerLevel: PluginProjectedActionV2['dangerLevel'],
): ActionDefinitionSummaryV1['sideEffectClass'] {
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
): ActionDefinitionSummaryV1 {
    const presentation = resolvePluginProjectedActionPresentation({
        pluginId: action.pluginId,
        presentation: action,
        projection,
        locale: getPreferredLanguage(),
    });
    const sideEffectClass = actionSideEffectClass(action.dangerLevel);
    const approval: NonNullable<ActionDefinitionSummaryV1['approval']> = action.dangerLevel === 'safe'
        ? { result: 'none' }
        : { result: 'required', flow: 'blocking' };
    return Object.freeze({
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
        ...(sideEffectClass ? { sideEffectClass } : {}),
    });
}

function isVoiceListedAction(
    readProjection: () => PluginUiProjectionModel | null,
    action: PluginProjectedActionV2,
): CurrentUiContextVoiceResolvedAction | null {
    if (!isPluginProjectedActionExecutable(action) || !action.surfaces.includes('voice')) return null;
    const resolved = resolveCurrentAction(readProjection, {
        pluginId: action.pluginId,
        localId: action.id,
    });
    return resolved?.action === action && hasCurrentClientActionRegistration(resolved)
        ? resolved
        : null;
}

/**
 * Reads one listed Voice Action's declared schemas from its projecting
 * machine, for the exact projected occurrence. The listing never carries them.
 */
async function readCurrentContributedActionSchemas(
    readProjection: () => PluginUiProjectionModel | null,
    id: string,
    signal: AbortSignal | undefined,
): Promise<CurrentUiContextVoiceActionSchemas | null> {
    const identity = parseQualifiedPluginActionId(id);
    if (!identity) return null;
    const action = createPluginUiProjectedActionResolver(readProjection()?.actionsById)(identity);
    const resolved = action ? isVoiceListedAction(readProjection, action) : null;
    if (!resolved) return null;
    const read = await machinePluginActionSchemasRead(resolved.origin.machineId, {
        serverId: resolved.origin.serverId,
        expectedOccurrenceId: resolved.action.occurrenceId,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity),
        ...(signal ? { signal } : {}),
    });
    if (!read.supported || !read.result.ok) return null;
    return Object.freeze({
        inputSchema: read.result.inputSchema,
        ...(read.result.outputSchema === undefined ? {} : { outputSchema: read.result.outputSchema }),
    });
}

function listCurrentContributedActionDefinitions(
    readProjection: () => PluginUiProjectionModel | null,
): readonly ActionDefinitionSummaryV1[] {
    const projection = readProjection();
    if (!projection) return [];
    const readSnapshot = () => projection;
    return Object.values(projection.actionsById)
        .filter((action) => isVoiceListedAction(readSnapshot, action) !== null)
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
        if (request.expectedContributorOccurrenceId !== undefined && request.expectedContributorOccurrenceId !== resolved.action.occurrenceId) {
            return { ok: false, code: 'stale_surface', errorCode: 'plugin_action_generation_retired', actionHandlerInvocation: 'notStarted' };
        }
        if (request.requiredDangerLevel === 'safe' && resolved.action.dangerLevel !== 'safe') {
            return { ok: false, code: 'denied', errorCode: 'plugin_action_read_requires_safe', actionHandlerInvocation: 'notStarted' };
        }
        const currentSessionId = input.reader.readCurrentSessionId?.() ?? null;
        const sessionId = request.defaultSessionId ?? currentSessionId;
        // Only an implicit viewed-Session binding retires on navigation. An
        // explicitly invoking Session (or a global Action) does not borrow it.
        const followsViewedSession = includeCurrentUiContext
            || ((input.invocationSurface ?? 'voice') === 'voice'
                && request.defaultSessionId === undefined && resolved.action.scopes.includes('session'));
        // Observe this invocation through the existing committed-context owner.
        // Equality alone would revive an old binding after Session A → B → A.
        const sessionRetirement = new AbortController();
        const checkSession = () => {
            if (followsViewedSession && (input.reader.readCurrentSessionId?.() ?? null) !== currentSessionId) sessionRetirement.abort();
        };
        const unsubscribe = input.reader.subscribe(checkSession);
        const mergedSignal = mergeAbortSignals([sessionRetirement.signal, request.signal]);
        checkSession();
        const isCurrent = (): boolean => (
            !mergedSignal.signal.aborted
            && (!followsViewedSession || (input.reader.readCurrentSessionId?.() ?? null) === currentSessionId)
            && isCallerCurrent()
            && isResolvedActionCurrent(input.readProjection, request.action, resolved)
        );
        if (!isCurrent()) {
            unsubscribe();
            mergedSignal.dispose();
            return stale();
        }
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
                invocationSurface: input.invocationSurface ?? 'voice',
                hostAction: {
                    execute: input.hostAction?.execute ?? (async (...args) => {
                        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                        return await createDefaultActionExecutor().execute(...args);
                    }),
                    context: { ...input.hostAction?.context,
                        ...(resolved.origin.serverId ? { serverId: resolved.origin.serverId } : {}),
                        ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    },
                },
                pluginUiProjection: input.readProjection(),
                clientAction: {
                    ...(sessionId ? { sessionId } : {}),
                    openSurface,
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
                            ...(sessionId ? { sessionId } : {}),
                            machineId: resolved.origin.machineId,
                            serverId: resolved.origin.serverId,
                        },
                    }
                    : {}),
                signal: mergedSignal.signal,
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
        } finally {
            unsubscribe();
            mergedSignal.dispose();
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
        readCurrentContributedActionSchemas: (id: string, signal?: AbortSignal) => (
            readCurrentContributedActionSchemas(input.readProjection, id, signal)
        ),
        invokeCurrentUiCommand,
        invokeAction,
    });
}

/**
 * The stable attempt-local port follows current AppShell facts through refs,
 * so an already-created Voice attempt cannot recover a retired projection or
 * navigation binding from a prior render. All reads remain provider-local;
 * the ordinary Action adapter borrows this factory rather than mirroring context.
 */
function useCurrentUiContextToolPortFactory() {
    const reader = useOptionalCurrentUiContextReader();
    const appShellProjection = useAppShellPluginUiProjection();
    const navigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const projectionRef = React.useRef(appShellProjection.pluginUiProjection);
    const navigationBindingRef = React.useRef(navigationBinding);
    projectionRef.current = appShellProjection.pluginUiProjection;
    navigationBindingRef.current = navigationBinding;

    return React.useCallback(
        (invocationSurface: PluginSurfaceActionInvocationSurface, hostAction?: PluginSurfaceHostActionBinding) => reader
            ? createCurrentUiContextVoiceToolPort({
                reader,
                invocationSurface,
                hostAction,
                readProjection: () => projectionRef.current,
                readNavigationBinding: () => navigationBindingRef.current,
            })
            : null,
        [reader],
    );
}

export function useCurrentUiContextVoiceToolPort(): CurrentUiContextVoiceToolPort | null {
    const createPort = useCurrentUiContextToolPortFactory();
    return React.useMemo(() => createPort('voice'), [createPort]);
}

/** Strict reverse ingress; execution still enters the ordinary Action front door. */
export function createCurrentUiContributedActionRpcHandler(input: Readonly<{
    machineId: string;
    serverId: string;
    readProjection: () => PluginUiProjectionModel | null;
    isCurrent: () => boolean;
    execute: PluginSurfaceHostActionExecute;
}>) {
    return async (params: unknown, context?: Readonly<{ signal: AbortSignal }>) => {
        const parsed = UiContributedActionExecuteRequestV1Schema.safeParse(params);
        if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', actionHandlerInvocation: 'notStarted' };
        const request = parsed.data;
        const resolved = resolveCurrentAction(input.readProjection, request.action);
        if (!input.isCurrent() || context?.signal.aborted || !resolved || resolved.action.execution.target !== 'client'
            || resolved.origin.machineId !== input.machineId || resolved.origin.serverId !== input.serverId
            || resolved.action.occurrenceId !== request.expectedContributorOccurrenceId || !hasCurrentClientActionRegistration(resolved)) {
            return { ok: false, errorCode: 'contributed_action_unavailable', error: 'current_ui_action_unavailable', actionHandlerInvocation: 'notStarted' };
        }
        try {
            const result = await input.execute('action.invoke', { action: request.action, input: request.input }, {
                surface: request.surface,
                serverId: input.serverId,
                expectedContributedActionOccurrenceId: request.expectedContributorOccurrenceId,
                ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
                ...(request.requiredDangerLevel ? { requiredContributedActionDangerLevel: request.requiredDangerLevel } : {}),
                ...(context?.signal ? { signal: context.signal } : {}),
            });
            const response = result.ok ? { ok: true, result: result.result ?? null } : {
                ok: false, errorCode: result.errorCode, error: result.error,
                ...(result.details !== null && typeof result.details === 'object' && Reflect.get(result.details, 'actionHandlerInvocation') === 'notStarted'
                    ? { actionHandlerInvocation: 'notStarted' } : {}),
            };
            const validated = UiContributedActionExecuteResponseV1Schema.safeParse(response);
            if (validated.success) return validated.data;
        } catch {
            // Once admitted, a lost or malformed settlement never proves the effect did not run.
        }
        return { ok: false, errorCode: PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE, error: PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE };
    };
}

/** Binds ordinary host Actions to the same provider-local reader and dispatcher. */
export function CurrentUiContextActionHost(): null {
    const createPort = useCurrentUiContextToolPortFactory();
    const appShellProjection = useAppShellPluginUiProjection();
    const server = useActiveServerSnapshot();
    const projectionRef = React.useRef(appShellProjection.pluginUiProjection);
    projectionRef.current = appShellProjection.pluginUiProjection;
    const machineIds = [...new Set(Object.values(appShellProjection.pluginUiProjection?.actionsById ?? {}).flatMap((action) => {
        const origin = readPluginUiContributionOrigin(action);
        return action.execution.target === 'client' && origin?.phase === 'current' && origin.interactionEnabled
            && origin.serverId === server.serverId ? [origin.machineId] : [];
    }))].sort().join('\u0000');
    React.useLayoutEffect(() => registerCurrentUiContextActionPort(createPort), [createPort]);
    React.useLayoutEffect(() => {
        if (!machineIds || !server.serverId) return;
        const disposers = machineIds.split('\u0000').map((machineId) => apiSocket.registerMachineScopedRpcHandler(
            machineId, RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE,
            createCurrentUiContributedActionRpcHandler({
                machineId, serverId: server.serverId,
                readProjection: () => projectionRef.current,
                isCurrent: () => getActiveServerSnapshot().serverId === server.serverId && getActiveServerSnapshot().generation === server.generation,
                execute: async (...args) => {
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    return await createDefaultActionExecutor().execute(...args);
                },
            }),
        ));
        return () => { for (const dispose of disposers) dispose(); };
    }, [createPort, machineIds, server.serverId, server.generation]);
    return null;
}

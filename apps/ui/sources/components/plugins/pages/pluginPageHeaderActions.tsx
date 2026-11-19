import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    createPluginUiProjectedActionResolver,
    isPluginProjectedActionExecutable,
    type PluginUiPageHeaderActionProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { comparePluginContributionOrder } from '@/sync/domains/plugins/contributionOrder';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { HAPPIER_PAGE_METRICS, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import {
    resolvePluginUiIconName,
} from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
    resolvePluginUiClientActionRegistration,
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import {
    type PluginSurfaceActionDispatchOutcome,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    launchPluginSurfaceAction,
} from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import type { PluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from '@/components/plugins/surfaces/openPluginSurface';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/**
 * Page-header chrome is a host presentation of the admitted app-page metadata,
 * not another contribution catalog. The Registry has already qualified the
 * semantic action; this adapter only applies the established ordering and dispatches
 * it through the same Action/openSurface owners used elsewhere in the shell.
 */
export function resolvePluginPageHeaderActions(
    page: PluginPage | null | undefined,
): readonly PluginUiPageHeaderActionProjection[] {
    if (!page) return Object.freeze([]);
    return Object.freeze([...page.placement.headerActions].sort(comparePluginContributionOrder));
}

export async function dispatchPluginPageHeaderAction(input: Readonly<{
    action: PluginUiPageHeaderActionProjection;
    page: PluginPage;
    /** Admitted UI projection; resolves declared confirmation wording. */
    projection?: PluginUiProjectionModel | null;
    /** Exact selected origin of the page that owns this header's chrome. */
    actionAuthority: PluginSurfaceLaunchAuthority | null | undefined;
    openSurface: PluginSurfaceOpenHandler;
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    execute?: PluginSurfaceContributedActionTransport;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    isDaemonExecutionCurrent?: () => boolean;
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
}>): Promise<
    PluginSurfaceActionDispatchOutcome
    | PluginSurfaceOpenOutcome
> {
    const semanticAction = input.action.command;
    if (semanticAction.kind === 'openSurface') {
        return await input.openSurface({
            destination: semanticAction.destination,
            ...(semanticAction.input === undefined ? {} : { input: semanticAction.input }),
            ...(semanticAction.subPath === undefined ? {} : { subPath: semanticAction.subPath }),
            ...(semanticAction.instanceKey === undefined ? {} : { instanceKey: semanticAction.instanceKey }),
        });
    }

    const projectedAction = input.resolveContributedAction?.(semanticAction.action) ?? null;
    if (!isPluginProjectedActionExecutable(projectedAction)) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const authority = input.actionAuthority;
    const occurrenceId = authority?.occurrenceId ?? null;
    const machineId = authority?.machineId?.trim() ?? '';
    // A daemon binding is a daemon-target fact, never a blanket action gate.
    // The canonical dispatcher still owns the target result and fail-closed
    // missing-projection outcome after this caller supplies its exact lookup.
    if (projectedAction?.execution.target === 'daemon' && (occurrenceId === null || machineId.length === 0
        || input.isDaemonExecutionCurrent?.() === false)) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const launched = await launchPluginSurfaceAction({
        callerPluginId: input.page.pluginId,
        action: semanticAction.action,
        ...(semanticAction.input === undefined ? {} : { input: semanticAction.input }),
        ...(input.resolveContributedAction
            ? { resolveContributedAction: input.resolveContributedAction }
            : {}),
        ...((projectedAction.execution.target === 'daemon'
            || (projectedAction.execution.target === 'account' && machineId.length > 0
                && input.isDaemonExecutionCurrent?.() !== false))
            ? {
                contributedAction: {
                    machineId,
                    serverId: authority?.serverId ?? null,
                    ...(projectedAction.execution.target === 'account' && authority?.accountLifetime
                        ? { accountLifetime: authority.accountLifetime } : {}),
                    ...(input.execute ? { execute: input.execute } : {}),
                },
            }
            : {}),
        ...((projectedAction.execution.target === 'account'
            || (projectedAction.execution.target === 'client' && occurrenceId !== null))
            ? {
                clientAction: {
                    ...(input.execute ? { execute: input.execute } : {}),
                    openSurface: input.openSurface,
                    ...(input.readCurrentUiContext
                        ? { currentUiContext: input.readCurrentUiContext }
                        : {}),
                },
            }
            : {}),
        pluginUiProjection: input.projection,
        ...(input.signal ? { signal: input.signal } : {}),
        ...((input.isCurrent || input.isDaemonExecutionCurrent) ? { isCurrent: () => (
            input.isCurrent?.() !== false
            && (projectedAction.execution.target !== 'daemon' || input.isDaemonExecutionCurrent?.() !== false)
        ) } : {}),
    });
    return launched.outcome;
}

export function PluginPageHeaderActions(props: Readonly<{
    actions: readonly PluginUiPageHeaderActionProjection[];
    page: PluginPage;
    projection: PluginUiProjectionModel | null | undefined;
    /** When a route binds a Machine, daemon Actions come from that Machine's projection. */
    machineActionsById?: PluginUiProjectionModel['actionsById'] | null;
    /** Exact selected origin; the app-wide union is catalog-only here. */
    actionAuthority: PluginSurfaceLaunchAuthority | null | undefined;
    openSurface: PluginSurfaceOpenHandler;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    isDaemonExecutionCurrent?: () => boolean;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const localize = usePluginLocalizedTextResolver({ projection: props.projection });
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    usePluginUiClientExecutableRegistrationRevision();
    const resolveContributedAction = React.useMemo((): PluginSurfaceContributedActionDescriptorResolver => {
        const resolveAppAction = createPluginUiProjectedActionResolver(props.projection?.actionsById);
        if (props.machineActionsById === undefined) return resolveAppAction;
        const resolveMachineAction = createPluginUiProjectedActionResolver(props.machineActionsById);
        return identity => {
            const machineAction = resolveMachineAction(identity);
            if (machineAction?.execution.target === 'daemon') return machineAction;
            const appAction = resolveAppAction(identity);
            return appAction?.execution.target === 'daemon' ? null : appAction;
        };
    }, [props.projection?.actionsById, props.machineActionsById]);
    if (props.actions.length === 0) return null;

    const canExecuteContributedAction = (action: PluginUiPageHeaderActionProjection): boolean => {
        if (action.command.kind !== 'executeAction') return true;
        const projectedAction = resolveContributedAction(action.command.action);
        if (!isPluginProjectedActionExecutable(projectedAction)) return false;
        const locallyCurrent = props.actionAuthority?.accountLifetime?.isCurrent() !== false
            && props.isCurrent?.() !== false;
        if (projectedAction.execution.target !== 'daemon') {
            return locallyCurrent
                && resolvePluginUiClientActionRegistration({
                    action: projectedAction,
                    platform: resolvePluginUiClientExecutablePlatform(),
                }) !== null;
        }
        return locallyCurrent
            && props.isDaemonExecutionCurrent?.() !== false
            && props.actionAuthority?.occurrenceId !== null
            && props.actionAuthority?.occurrenceId !== undefined
            && (props.actionAuthority?.machineId?.trim().length ?? 0) > 0;
    };

    return (
        <View style={{ alignItems: 'center', flexDirection: 'row' }}>
            {props.actions.map((action) => {
                const title = localize(props.page.pluginId, action.title);
                const disabled = action.command.kind === 'executeAction' && !canExecuteContributedAction(action);
                return (
                    <PluginPageHeaderActionButton
                        key={action.id}
                        id={action.id}
                        title={title}
                        disabled={disabled}
                        icon={action.icon}
                        color={theme.colors.chrome.header.foreground}
                        onPress={disabled ? undefined : () => {
                            fireAndForget(dispatchPluginPageHeaderAction({
                                action,
                                page: props.page,
                                projection: props.projection,
                                actionAuthority: props.actionAuthority,
                                openSurface: props.openSurface,
                                resolveContributedAction,
                                ...(props.signal ? { signal: props.signal } : {}),
                                ...(props.isCurrent ? { isCurrent: props.isCurrent } : {}),
                                ...(props.isDaemonExecutionCurrent ? { isDaemonExecutionCurrent: props.isDaemonExecutionCurrent } : {}),
                                ...(currentUiContextReader
                                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                                    : {}),
                            }), { tag: 'PluginPageHeaderActions.dispatch' });
                        }}
                    />
                );
            })}
        </View>
    );
}

/**
 * One icon action in a plugin page's header. It is drawn at the shared control height; under a finger
 * the shared hit-area owner reaches the touch target vertically. The actions sit flush, so the hit
 * area never reaches sideways into a neighbour.
 */
function PluginPageHeaderActionButton(props: Readonly<{
    id: string;
    title: string;
    disabled: boolean;
    icon: PluginUiPageHeaderActionProjection['icon'];
    color: string;
    onPress: (() => void) | undefined;
}>): React.ReactElement {
    const hitArea = useHappierHitArea({ restingStyle: () => DRAWN_FRAME, hitReach: { left: 0, right: 0 } });
    return (
        <Pressable
            accessibilityLabel={props.title}
            accessibilityRole="button"
            disabled={props.disabled}
            testID={`plugin-app-page-header-action:${props.id}`}
            onPress={props.onPress}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            style={({ pressed }) => ({
                ...DRAWN_FRAME,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: props.disabled ? 0.45 : pressed ? motionTokens.press.opacity : 1,
            })}
        >
            {hitArea.frame}
            <Icon
                name={resolvePluginUiIconName(props.icon)}
                size={ICON_SIZE.md}
                color={props.color}
            />
        </Pressable>
    );
}

const DRAWN_FRAME = { height: HAPPIER_PAGE_METRICS.controlHeightPx, width: HAPPIER_PAGE_METRICS.controlHeightPx } as const;

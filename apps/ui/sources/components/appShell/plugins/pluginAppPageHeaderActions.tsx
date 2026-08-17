import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type {
    PluginUiPageHeaderActionProjection,
    PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { comparePluginContributionOrder } from '@/sync/domains/plugins/contributionOrder';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import {
    resolvePluginUiIconName,
} from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceActionDispatchOutcome,
    type PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { PluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from '@/components/plugins/surfaces/openPluginSurface';

import type { PluginAppPage } from './pluginAppPages';

/**
 * Page-header chrome is a host presentation of the admitted app-page metadata,
 * not another contribution catalog. The Registry has already qualified the
 * command; this adapter only applies the established ordering and dispatches
 * it through the same Action/openSurface owners used elsewhere in the shell.
 */
export function resolvePluginAppPageHeaderActions(
    page: PluginAppPage | null | undefined,
): readonly PluginUiPageHeaderActionProjection[] {
    if (!page) return Object.freeze([]);
    return Object.freeze([...page.placement.headerActions].sort(comparePluginContributionOrder));
}

export async function dispatchPluginAppPageHeaderAction(input: Readonly<{
    action: PluginUiPageHeaderActionProjection;
    page: PluginAppPage;
    /** Exact selected origin of the page that owns this header's chrome. */
    actionAuthority: PluginSurfaceLaunchAuthority | null | undefined;
    openSurface: PluginSurfaceOpenHandler;
    execute?: PluginSurfaceContributedActionTransport;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<PluginSurfaceActionDispatchOutcome | PluginSurfaceOpenOutcome> {
    if (input.action.command.kind === 'openSurface') {
        return await input.openSurface({
            destination: input.action.command.destination,
            ...(input.action.command.input === undefined ? {} : { input: input.action.command.input }),
            ...(input.action.command.subPath === undefined ? {} : { subPath: input.action.command.subPath }),
            ...(input.action.command.instanceKey === undefined ? {} : { instanceKey: input.action.command.instanceKey }),
        });
    }

    const authority = input.actionAuthority;
    const generation = authority?.generation ?? null;
    const machineId = authority?.machineId?.trim() ?? '';
    if (generation === null || machineId.length === 0) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    return await dispatchPluginSurfaceAction({
        callerPluginId: input.page.pluginId,
        action: input.action.command.action,
        // Absence has one canonical RPC sentinel for a contributed Action;
        // the page-header command itself retains absence for openSurface.
        input: input.action.command.input ?? null,
        contributedAction: {
            machineId,
            serverId: authority?.serverId ?? null,
            expectedGeneration: String(generation),
            ...(input.execute ? { execute: input.execute } : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    });
}

function readHeaderActionTitle(input: Readonly<{
    action: PluginUiPageHeaderActionProjection;
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
}>): string {
    const title = input.action.title;
    return resolvePluginUiText({
        projection: input.projection,
        pluginId: input.pluginId,
        key: typeof title === 'string' ? null : title.key,
        locale: getPreferredLanguage(),
        fallback: typeof title === 'string' ? title : title.fallback,
    });
}

export function PluginAppPageHeaderActions(props: Readonly<{
    actions: readonly PluginUiPageHeaderActionProjection[];
    page: PluginAppPage;
    projection: PluginUiProjectionModel | null | undefined;
    /** Exact selected origin; the app-wide union is catalog-only here. */
    actionAuthority: PluginSurfaceLaunchAuthority | null | undefined;
    openSurface: PluginSurfaceOpenHandler;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    if (props.actions.length === 0) return null;

    const canExecuteContributedAction = (
        props.actionAuthority?.generation !== null
        && props.actionAuthority?.generation !== undefined
        && (props.actionAuthority?.machineId?.trim().length ?? 0) > 0
        && props.actionAuthority?.accountLifetime?.isCurrent() !== false
        && props.isCurrent?.() !== false
    );

    return (
        <View style={{ alignItems: 'center', flexDirection: 'row' }}>
            {props.actions.map((action) => {
                const title = readHeaderActionTitle({
                    action,
                    projection: props.projection,
                    pluginId: props.page.pluginId,
                });
                const disabled = action.command.kind === 'executeAction' && !canExecuteContributedAction;
                return (
                    <Pressable
                        key={action.id}
                        accessibilityLabel={title}
                        accessibilityRole="button"
                        disabled={disabled}
                        testID={`plugin-app-page-header-action:${action.id}`}
                        onPress={disabled ? undefined : () => {
                            fireAndForget(dispatchPluginAppPageHeaderAction({
                                action,
                                page: props.page,
                                actionAuthority: props.actionAuthority,
                                openSurface: props.openSurface,
                                ...(props.signal ? { signal: props.signal } : {}),
                                ...(props.isCurrent ? { isCurrent: props.isCurrent } : {}),
                            }), { tag: 'PluginAppPageHeaderActions.dispatch' });
                        }}
                        style={({ pressed }) => ({
                            alignItems: 'center',
                            height: minimumInteractiveTargetSize,
                            justifyContent: 'center',
                            opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
                            width: minimumInteractiveTargetSize,
                        })}
                    >
                        <Icon
                            name={resolvePluginUiIconName(action.icon)}
                            size={ICON_SIZE.md}
                            color={theme.colors.chrome.header.foreground}
                        />
                    </Pressable>
                );
            })}
        </View>
    );
}

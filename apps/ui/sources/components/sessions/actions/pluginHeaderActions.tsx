import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { canRenderPluginUiProjectionEntry } from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiProjectionModel,
    PluginUiSessionHeaderActionProjection,
} from '@/sync/domains/plugins/ui/projection';

export const PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX = 'plugin-ui:';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readDisplayTitleKey(action: PluginUiSessionHeaderActionProjection): string {
    const display = readRecord(action.display);
    const titleKey = display?.titleKey;
    return typeof titleKey === 'string' && titleKey.trim().length > 0 ? titleKey : action.descriptorId;
}

function readDisplayIconToken(action: PluginUiSessionHeaderActionProjection): string | null {
    const display = readRecord(action.display);
    const iconToken = display?.iconToken;
    return typeof iconToken === 'string' && iconToken.trim().length > 0 ? iconToken : null;
}

function isSupportedHeaderAction(action: PluginUiSessionHeaderActionProjection): boolean {
    const actionDescriptor = readRecord(action.action);
    if (!actionDescriptor || actionDescriptor.kind !== 'openSurface') {
        return false;
    }
    const target = readRecord(actionDescriptor.target);
    const surfaceId = target?.surfaceId;
    return typeof surfaceId === 'string' && surfaceId.trim().length > 0;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function resolveIconName(iconToken: string | null): IoniconName {
    switch (iconToken) {
        case 'browser':
        case 'globe':
            return 'globe-outline';
        case 'copy':
            return 'copy-outline';
        case 'file':
            return 'document-text-outline';
        case 'preview':
            return 'eye-outline';
        case 'refresh':
            return 'refresh-outline';
        case 'settings':
            return 'settings-outline';
        case 'terminal':
            return 'terminal-outline';
        case 'warning':
            return 'warning-outline';
        case 'action':
        case 'info':
        default:
            return 'extension-puzzle-outline';
    }
}

export function createPluginSessionHeaderActionMenuId(action: PluginUiSessionHeaderActionProjection): string {
    return `${PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX}${action.id}`;
}

export function createPluginSessionHeaderActionDropdownItems(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    iconColor: string;
    locale?: string | null;
}>): readonly DropdownMenuItem[] {
    const projection = params.projection;
    if (!projection) {
        return [];
    }

    return Object.values(projection.sessionHeaderActionsById)
        .filter(canRenderPluginUiProjectionEntry)
        .filter(isSupportedHeaderAction)
        .sort((left, right) => {
            const leftOrder = typeof left.order === 'number' ? left.order : 0;
            const rightOrder = typeof right.order === 'number' ? right.order : 0;
            return leftOrder - rightOrder || left.id.localeCompare(right.id);
        })
        .map((action): DropdownMenuItem => ({
            id: createPluginSessionHeaderActionMenuId(action),
            title: resolvePluginUiText({
                projection,
                pluginId: action.pluginId,
                key: readDisplayTitleKey(action),
                locale: params.locale,
                fallback: action.descriptorId,
            }),
            icon: <Ionicons name={resolveIconName(readDisplayIconToken(action))} size={16} color={params.iconColor} />,
        }));
}

export function resolvePluginSessionHeaderActionOpenSurface(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    menuActionId: string;
}>): string | null {
    if (!params.menuActionId.startsWith(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX)) {
        return null;
    }
    const descriptorId = params.menuActionId.slice(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX.length);
    const action = params.projection?.sessionHeaderActionsById[descriptorId];
    const actionDescriptor = readRecord(action?.action);
    if (!actionDescriptor || actionDescriptor.kind !== 'openSurface') {
        return null;
    }
    const target = readRecord(actionDescriptor.target);
    const surfaceId = target?.surfaceId;
    return typeof surfaceId === 'string' && surfaceId.trim().length > 0 ? surfaceId : null;
}

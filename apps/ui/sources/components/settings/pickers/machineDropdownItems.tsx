import * as React from 'react';


import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { Machine } from '@/sync/domains/state/storageTypes';

function getMachineLabel(machine: Machine, unknownMachineLabel: string): string {
    const meta: any = machine.metadata ?? null;
    const displayName = typeof meta?.displayName === 'string' ? meta.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof meta?.host === 'string' ? meta.host.trim() : '';
    if (host) return host;
    return String(machine.id ?? '').trim() || unknownMachineLabel;
}

function getMachineSubtitle(machine: Machine, onlineLabel: string, offlineLabel: string): string {
    const host = typeof (machine.metadata as any)?.host === 'string' ? String((machine.metadata as any).host).trim() : '';
    const id = String(machine.id ?? '').trim();
    const status = machine.active ? onlineLabel : offlineLabel;
    const hostPart = host && host !== id ? host : '';
    const idPart = id ? `(${id})` : '';
    return [status, hostPart, idPart].filter(Boolean).join(' ');
}

export function getMachineDropdownMenuItems(params: Readonly<{
    machines: readonly Machine[];
    iconColor: string;
    iconSize?: number;
    includeAuto?: boolean;
    autoTitle?: string;
    autoSubtitle?: string;
    onlineLabel?: string;
    offlineLabel?: string;
    unknownMachineLabel?: string;
}>): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    const items: DropdownMenuItem[] = [];

    if (params.includeAuto) {
        items.push({
            id: 'auto',
            title: params.autoTitle ?? 'Auto',
            subtitle: params.autoSubtitle ?? 'Automatically choose a stable machine.',
            icon: renderDropdownItemIcon({
                name: 'sparkle',
                color: params.iconColor,
                size: iconSize,
            }),
        });
    }

    for (const machine of params.machines ?? []) {
        if (!machine || typeof machine.id !== 'string') continue;
        items.push({
            id: machine.id,
            title: getMachineLabel(machine, params.unknownMachineLabel ?? 'Unknown machine'),
            subtitle: getMachineSubtitle(machine, params.onlineLabel ?? 'Online', params.offlineLabel ?? 'Offline'),
            icon: renderDropdownItemIcon({
                name: 'desktop',
                color: params.iconColor,
                size: iconSize,
            }),
        });
    }

    return items;
}

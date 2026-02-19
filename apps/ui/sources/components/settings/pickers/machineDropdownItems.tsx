import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { Machine } from '@/sync/domains/state/storageTypes';

function getMachineLabel(machine: Machine): string {
    const meta: any = machine.metadata ?? null;
    const displayName = typeof meta?.displayName === 'string' ? meta.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof meta?.host === 'string' ? meta.host.trim() : '';
    if (host) return host;
    return String(machine.id ?? '').trim() || 'Unknown machine';
}

function getMachineSubtitle(machine: Machine): string {
    const host = typeof (machine.metadata as any)?.host === 'string' ? String((machine.metadata as any).host).trim() : '';
    const id = String(machine.id ?? '').trim();
    const status = machine.active ? 'Online' : 'Offline';
    const hostPart = host && host !== id ? host : '';
    const idPart = id ? `(${id})` : '';
    return [status, hostPart, idPart].filter(Boolean).join(' ');
}

export function getMachineDropdownMenuItems(params: Readonly<{
    machines: readonly Machine[];
    iconColor: string;
    iconSize?: number;
    includeAuto?: boolean;
    autoSubtitle?: string;
}>): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    const items: DropdownMenuItem[] = [];

    if (params.includeAuto) {
        items.push({
            id: 'auto',
            title: 'Auto',
            subtitle: params.autoSubtitle ?? 'Automatically choose a stable machine.',
            icon: <Ionicons name="sparkles-outline" size={iconSize} color={params.iconColor} />,
        });
    }

    for (const machine of params.machines ?? []) {
        if (!machine || typeof machine.id !== 'string') continue;
        items.push({
            id: machine.id,
            title: getMachineLabel(machine),
            subtitle: getMachineSubtitle(machine),
            icon: <Ionicons name="desktop-outline" size={iconSize} color={params.iconColor} />,
        });
    }

    return items;
}


import * as React from 'react';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';

/** A held collection projection; native pagination, Account scope and push recovery stay with P20. */
export function useStorePresets(serverIds: readonly string[]) {
    const collection = useMachinePresets(serverIds);
    const rows = React.useMemo(() => Object.entries(collection.presetsByServerId).flatMap(([serverId, presets]) =>
        presets.filter(preset => preset.archivedAt == null).map(preset => ({ serverId, preset, counts: {
            apps: preset.setup?.items?.filter(item => item.kind === 'app').length ?? 0,
            software: preset.setup?.items?.filter(item => item.kind === 'softwareRecipe').length ?? 0,
            setupRecipes: preset.setup?.items?.filter(item => item.kind === 'setupRecipe').length ?? 0,
            scripts: preset.setup?.scripts?.length ?? 0,
        } }))), [collection.presetsByServerId]);
    return { ...collection, rows };
}

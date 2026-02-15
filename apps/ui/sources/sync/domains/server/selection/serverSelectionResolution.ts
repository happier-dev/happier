import { getEffectiveServerSelection, resolveActiveServerSelection } from './serverSelectionResolver';
import { toServerSelectionSettings } from './serverSelectionSettingsAdapter';
import type { EffectiveServerSelection, ResolvedActiveServerSelection } from './serverSelectionTypes';

export type RawServerSelectionSettings = Readonly<{
    serverSelectionGroups: unknown;
    serverSelectionActiveTargetKind: unknown;
    serverSelectionActiveTargetId: unknown;
}>;

export function resolveActiveServerSelectionFromRawSettings(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: RawServerSelectionSettings;
}>): ResolvedActiveServerSelection {
    return resolveActiveServerSelection({
        activeServerId: params.activeServerId,
        availableServerIds: params.availableServerIds,
        settings: toServerSelectionSettings(params.settings),
    });
}

export function getEffectiveServerSelectionFromRawSettings(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: RawServerSelectionSettings;
}>): EffectiveServerSelection {
    return getEffectiveServerSelection({
        activeServerId: params.activeServerId,
        availableServerIds: params.availableServerIds,
        settings: toServerSelectionSettings(params.settings),
    });
}

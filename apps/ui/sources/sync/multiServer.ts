import type { Settings } from './settings';

export type MultiServerPresentation = 'grouped' | 'flat-with-badge';

export type EffectiveServerSelection = Readonly<{
    enabled: boolean;
    serverIds: string[];
    presentation: MultiServerPresentation;
}>;

type MultiServerProfile = Readonly<{
    id: string;
    serverIds: ReadonlyArray<string>;
    presentation?: MultiServerPresentation | null;
}>;

type MultiServerSelectionSettings = Pick<
    Settings,
    'multiServerEnabled' | 'multiServerSelectedServerIds' | 'multiServerPresentation'
> & Partial<Pick<Settings, 'multiServerProfiles' | 'multiServerActiveProfileId'>>;

export type NewSessionServerTargeting = Readonly<{
    allowedServerIds: string[];
    pickerEnabled: boolean;
}>;

export type ResolvedNewSessionServerTarget = Readonly<{
    targetServerId: string | null;
    rejectedRequestedServerId: string | null;
}>;

function isConcurrentModeRuntimeEnabled(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT ?? '').trim().toLowerCase();
    if (!raw) return true;
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
}

function normalizeServerIds(ids: ReadonlyArray<string>, available: Set<string>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const rawId of ids) {
        const id = String(rawId ?? '').trim();
        if (!id) continue;
        if (!available.has(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

function normalizeIdList(ids: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const rawId of ids) {
        const id = String(rawId ?? '').trim();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

export function getEffectiveServerSelection(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: MultiServerSelectionSettings;
}>): EffectiveServerSelection {
    const available = new Set(params.availableServerIds.map((id) => String(id ?? '').trim()).filter(Boolean));
    const activeServerId = String(params.activeServerId ?? '').trim();
    const fallbackServerId = available.has(activeServerId)
        ? activeServerId
        : (params.availableServerIds.find((id) => available.has(String(id ?? '').trim())) ?? '').trim();

    const presentation: MultiServerPresentation =
        params.settings.multiServerPresentation === 'flat-with-badge' ? 'flat-with-badge' : 'grouped';

    if (!params.settings.multiServerEnabled || !isConcurrentModeRuntimeEnabled()) {
        return {
            enabled: false,
            serverIds: fallbackServerId ? [fallbackServerId] : [],
            presentation,
        };
    }

    const activeProfileId = String(params.settings.multiServerActiveProfileId ?? '').trim();
    const profilesRaw = Array.isArray(params.settings.multiServerProfiles)
        ? (params.settings.multiServerProfiles as unknown as MultiServerProfile[])
        : [];
    const activeProfile = activeProfileId
        ? profilesRaw.find((profile) => String(profile?.id ?? '').trim() === activeProfileId)
        : null;

    if (activeProfile) {
        const profileSelected = normalizeServerIds(activeProfile.serverIds ?? [], available);
        if (profileSelected.length > 0) {
            const profilePresentation: MultiServerPresentation =
                activeProfile.presentation === 'flat-with-badge' ? 'flat-with-badge' : 'grouped';
            return {
                enabled: true,
                serverIds: profileSelected,
                presentation: profilePresentation,
            };
        }
    }

    const selected = normalizeServerIds(params.settings.multiServerSelectedServerIds ?? [], available);
    if (selected.length > 0) {
        return {
            enabled: true,
            serverIds: selected,
            presentation,
        };
    }

    return {
        enabled: true,
        serverIds: fallbackServerId ? [fallbackServerId] : [],
        presentation,
    };
}

export function getNewSessionServerTargeting(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: MultiServerSelectionSettings;
}>): NewSessionServerTargeting {
    const selection = getEffectiveServerSelection(params);
    const allowedServerIds = normalizeIdList(selection.serverIds);
    return {
        allowedServerIds,
        pickerEnabled: selection.enabled && allowedServerIds.length > 1,
    };
}

export function resolveNewSessionServerTarget(params: Readonly<{
    requestedServerId?: string | null;
    activeServerId: string;
    allowedServerIds: ReadonlyArray<string>;
}>): ResolvedNewSessionServerTarget {
    const allowedServerIds = normalizeIdList(params.allowedServerIds);
    if (allowedServerIds.length === 0) {
        return {
            targetServerId: null,
            rejectedRequestedServerId: null,
        };
    }

    const activeServerId = String(params.activeServerId ?? '').trim();
    const fallbackServerId = allowedServerIds.includes(activeServerId) ? activeServerId : (allowedServerIds[0] ?? null);
    const requestedServerId = String(params.requestedServerId ?? '').trim();

    if (!requestedServerId) {
        return {
            targetServerId: fallbackServerId,
            rejectedRequestedServerId: null,
        };
    }

    if (allowedServerIds.includes(requestedServerId)) {
        return {
            targetServerId: requestedServerId,
            rejectedRequestedServerId: null,
        };
    }

    return {
        targetServerId: fallbackServerId,
        rejectedRequestedServerId: requestedServerId,
    };
}

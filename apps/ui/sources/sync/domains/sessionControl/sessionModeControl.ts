import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { getBuiltInAcpConfig, parsePermissionIntentAlias, resolveAcpAgentModeId } from '@happier-dev/agents';
import { resolveRequestedSessionModeId } from '@happier-dev/protocol';
import { tLoose } from '@/text';

import { matchesSessionControlProvider, readSessionModeOverrideState, readSessionModesState } from './readSessionControlMetadata';

export function supportsSessionModeOverrides(agentId: AgentId): boolean {
    const kind = getAgentCore(agentId).sessionModes.kind;
    return kind !== 'none';
}

export type SessionModeOption = Readonly<{
    id: string;
    name: string;
    description?: string;
}>;

/** Agents whose native approval levels belong to the permission selector expose only agent modes in Mode. */
function splitsAgentModesFromPermissions(agentId: AgentId): boolean {
    return getBuiltInAcpConfig(agentId)?.agentModeIds !== undefined;
}

function filterAgentModeOptions(options: readonly SessionModeOption[], agentId: AgentId): readonly SessionModeOption[] {
    return options.filter((option) => resolveAcpAgentModeId(agentId, option.id) !== null);
}

/** A selected mode id as Mode shows it: for a splitting agent, a stored approval level is Build (''). */
export function resolveSessionModeSelectionId(agentId: AgentId, modeId: string): string {
    return splitsAgentModesFromPermissions(agentId) ? resolveAcpAgentModeId(agentId, modeId) ?? '' : modeId;
}

// Build clears the mode override, so the permission mapping chooses the native approval mode.
function buildModeOption(): SessionModeOption {
    return { id: '', name: tLoose('agentInput.mode.build'), description: tLoose('agentInput.mode.buildDescription') };
}

// Without a native Default, the 'default' sentinel clears the override (see resolveRequestedSessionModeId).
export function getSessionModePickerOptions(options: readonly SessionModeOption[], agentId: AgentId): readonly SessionModeOption[] {
    const nativeOptions = Array.from(new Map(options.map((option) => [option.id, option])).values());
    if (splitsAgentModesFromPermissions(agentId)) return [buildModeOption(), ...filterAgentModeOptions(nativeOptions, agentId)];
    if (nativeOptions.some((option) => option.id === 'default')) return nativeOptions;
    return [{ id: 'default', name: tLoose('common.default') }, ...nativeOptions];
}

export type SessionModePickerControl = Readonly<{
    agentId: AgentId;
    options: readonly SessionModeOption[];
    currentModeId: string;
    currentModeName: string;
    requestedModeId: string | null;
    isExplicitOverride: boolean;
    requestedModeName: string | null;
    effectiveModeId: string;
    effectiveModeName: string;
    isPending: boolean;
}>;

export function resolveRequestedSessionModeIdForMetadata(
    control: SessionModePickerControl | null | undefined,
    requestedModeId: string,
): string {
    return resolveRequestedSessionModeId(requestedModeId, control?.options ?? []);
}

function computeLegacyRequestedModeIdFromPermissionMode(
    metadata: Metadata | null | undefined,
    options: readonly SessionModeOption[],
): string | null {
    const raw = typeof metadata?.permissionMode === 'string' ? metadata.permissionMode : '';
    const intent = raw ? parsePermissionIntentAlias(raw) : null;
    return intent === 'plan' && options.some((option) => option.id === 'plan') ? 'plan' : null;
}

function computeStaticSessionModePickerControl(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): SessionModePickerControl | null {
    const core = getAgentCore(params.agentId);
    if (core.sessionModes.kind !== 'staticAgentModes') return null;
    const staticOptionsRaw = core.sessionModes.staticOptions ?? [];
    if (!Array.isArray(staticOptionsRaw) || staticOptionsRaw.length === 0) return null;

    const options: SessionModeOption[] = staticOptionsRaw
        .filter((opt) => opt && typeof opt.id === 'string' && typeof opt.nameKey === 'string')
        .map((opt) => ({
            id: opt.id,
            name: tLoose(opt.nameKey),
            ...(typeof opt.descriptionKey === 'string' ? { description: tLoose(opt.descriptionKey) } : {}),
        }))
        .filter((opt) => opt.id.trim().length > 0 && opt.name.trim().length > 0);

    const defaultOption = options.find((o) => o.id === 'default') ?? null;
    if (!defaultOption) return null;

    const modeOverride = readSessionModeOverrideState(params.metadata);
    const legacy = computeLegacyRequestedModeIdFromPermissionMode(params.metadata, options);
    const requestedModeId = modeOverride
        ? (modeOverride.state === 'set' ? modeOverride.value : null)
        : legacy ?? null;
    const requestedMode = requestedModeId ? options.find((mode) => mode.id === requestedModeId) ?? null : null;

    const currentModeId = 'default';
    const currentModeName = defaultOption.name;
    const effectiveModeId = requestedModeId ?? currentModeId;
    const effectiveMode = options.find((mode) => mode.id === effectiveModeId) ?? defaultOption;

    // Static modes have no provider-ack current mode signal, so we cannot report a meaningful pending state.
    const isPending = false;

    return {
        agentId: params.agentId,
        options,
        currentModeId,
        currentModeName,
        requestedModeId,
        isExplicitOverride: modeOverride?.state === 'set',
        requestedModeName: requestedMode?.name ?? requestedModeId,
        effectiveModeId,
        effectiveModeName: effectiveMode?.name ?? effectiveModeId,
        isPending,
    };
}

function computeDynamicSessionModePickerControlInternal(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): SessionModePickerControl | null {
    const kind = getAgentCore(params.agentId).sessionModes.kind;
    if (kind !== 'acpAgentModes' && kind !== 'acpPolicyPresets') return null;

    const state = readSessionModesState(params.metadata);
    if (!state) return null;
    if (!matchesSessionControlProvider({ ...params, provider: state.provider })) return null;
    if (state.availableModes.length === 0) return null;

    if (!state.currentModeId) return null;
    // A splitting agent projects its native approval levels onto Build (the empty id).
    const splits = splitsAgentModesFromPermissions(params.agentId);
    const options = splits ? filterAgentModeOptions(state.availableModes, params.agentId) : state.availableModes;
    // Build alone is no choice: an agent whose advertised modes are all approval levels has no Mode control.
    if (options.length === 0) return null;
    const namedOptions = splits ? [buildModeOption(), ...options] : options;
    const currentModeId = resolveSessionModeSelectionId(params.agentId, state.currentModeId);

    const modeOverride = readSessionModeOverrideState(params.metadata);
    const overrideModeId = modeOverride?.state === 'set'
        ? (splits ? resolveAcpAgentModeId(params.agentId, modeOverride.value) : modeOverride.value)
        : null;
    const legacy = computeLegacyRequestedModeIdFromPermissionMode(params.metadata, options);
    const requestedModeId = modeOverride ? overrideModeId : legacy ?? null;
    const effectiveModeId = requestedModeId ?? currentModeId;

    const currentMode = namedOptions.find((mode) => mode.id === currentModeId) ?? null;
    const requestedMode = requestedModeId ? options.find((mode) => mode.id === requestedModeId) ?? null : null;
    const effectiveMode = namedOptions.find((mode) => mode.id === effectiveModeId) ?? null;
    const isPending = Boolean(requestedModeId && requestedModeId !== currentModeId);

    return {
        agentId: params.agentId,
        options,
        currentModeId,
        currentModeName: currentMode?.name ?? currentModeId,
        requestedModeId,
        isExplicitOverride: overrideModeId !== null,
        requestedModeName: requestedMode?.name ?? requestedModeId,
        effectiveModeId,
        effectiveModeName: effectiveMode?.name ?? effectiveModeId,
        isPending,
    };
}

export function computeSessionModePickerControl(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): SessionModePickerControl | null {
    if (!supportsSessionModeOverrides(params.agentId)) return null;
    return computeDynamicSessionModePickerControlInternal(params) ?? computeStaticSessionModePickerControl(params);
}

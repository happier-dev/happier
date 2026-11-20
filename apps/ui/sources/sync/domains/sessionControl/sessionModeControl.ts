import { getAgentCore } from '@/agents/catalog/catalog';
import type { Metadata } from '@happier-dev/session-core/state';
import {
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    normalizeBundledAgentRoutingId,
    parsePermissionIntentAlias,
    readAcpSessionModeIntentFromMetadata,
    readMetadataAliasValue,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';
import { resolveRequestedSessionModeId } from '@happier-dev/protocol/actions/sessionModeIds';
import { tLoose } from '@/text';

import { parseSessionModeOverrideState } from './schema';
import { readSessionModesState } from './readSessionControlMetadata';

function supportsSessionModeOverrides(agentId: string): boolean {
    // An Agent with no bundled core contributes its session modes through its
    // own plugin; the static bundled table has nothing to say about it.
    const kind = getAgentCore(agentId)?.sessionModes.kind;
    return kind !== undefined && kind !== 'none';
}

export type SessionModeOption = Readonly<{
    id: string;
    name: string;
    description?: string;
}>;

// The empty id reuses clear intent without hiding the provider's native Default.
export function getSessionModePickerOptions(options: readonly SessionModeOption[], agentId: string): readonly SessionModeOption[] {
    const nativeOptions = Array.from(new Map(options.map((option) => [option.id, option])).values());
    const hasNativeDefault = nativeOptions.some((option) => option.id === 'default');
    if (hasNativeDefault && !getAgentCore(normalizeBundledAgentRoutingId(agentId))?.permissions.permissionModeMapping) return nativeOptions;
    return [
        {
            id: hasNativeDefault ? '' : 'default',
            name: tLoose(hasNativeDefault ? 'agentInput.permissionMode.usePermissionSetting' : 'common.default'),
        },
        ...nativeOptions,
    ];
}

export type SessionModePickerControl = Readonly<{
    agentId: string;
    options: readonly SessionModeOption[];
    currentModeId: string | null;
    currentModeName: string;
    requestedModeId: string | null;
    isExplicitOverride: boolean;
    requestedModeName: string | null;
    effectiveModeId: string | null;
    effectiveModeName: string;
    isPending: boolean;
}>;

export function resolveRequestedSessionModeIdForMetadata(
    control: SessionModePickerControl | null | undefined,
    requestedModeId: string,
): string {
    return resolveRequestedSessionModeId(requestedModeId, control?.options ?? []);
}

function computeLegacyRequestedModeIdFromPermissionMode(metadata: Metadata | null | undefined, options: readonly SessionModeOption[]): string | null {
    const raw = typeof metadata?.permissionMode === 'string' ? metadata.permissionMode : '';
    const intent = raw ? parsePermissionIntentAlias(raw) : null;
    return intent === 'plan' && options.some((option) => option.id === 'plan') ? 'plan' : null;
}

function readSessionModeOverride(metadata: Metadata | null | undefined) {
    return readAcpSessionModeIntentFromMetadata((metadata as any) ?? {})
        ?? parseSessionModeOverrideState(
            readMetadataAliasValue((metadata as any) ?? {}, SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY),
        );
}

function createExplicitSessionModePickerControl(params: Readonly<{
    agentId: string;
    modeId: string;
    currentModeId?: string | null;
}>): SessionModePickerControl {
    const currentModeId = params.currentModeId ?? null;
    return {
        agentId: params.agentId,
        options: [{ id: params.modeId, name: params.modeId }],
        currentModeId,
        currentModeName: currentModeId ?? tLoose('agentInput.mode.sectionTitle'),
        requestedModeId: params.modeId,
        isExplicitOverride: true,
        requestedModeName: params.modeId,
        effectiveModeId: params.modeId,
        effectiveModeName: params.modeId,
        isPending: params.modeId !== currentModeId,
    };
}

function computeStaticSessionModePickerControl(params: {
    agentId: string;
    metadata: Metadata | null | undefined;
    modeOverride: ReturnType<typeof readSessionModeOverride>;
}): SessionModePickerControl | null {
    const core = getAgentCore(params.agentId);
    if (core?.sessionModes.kind !== 'staticAgentModes') return null;
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

    const { modeOverride } = params;
    const legacy = computeLegacyRequestedModeIdFromPermissionMode(params.metadata, options);
    const requestedModeId = modeOverride ? modeOverride.modeId : legacy;
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
        isExplicitOverride: modeOverride?.modeId != null,
        requestedModeName: requestedMode?.name ?? requestedModeId,
        effectiveModeId,
        effectiveModeName: effectiveMode?.name ?? effectiveModeId,
        isPending,
    };
}

function computeDynamicSessionModePickerControlInternal(params: {
    agentId: string;
    metadata: Metadata | null | undefined;
    state: NonNullable<ReturnType<typeof readSessionModesState>>;
    modeOverride: ReturnType<typeof readSessionModeOverride>;
}): SessionModePickerControl | null {
    const { state, modeOverride } = params;
    if (state.availableModes.length === 0) {
        return modeOverride?.modeId
            ? createExplicitSessionModePickerControl({
                agentId: params.agentId,
                modeId: modeOverride.modeId,
                currentModeId: state.currentModeId,
            })
            : null;
    }

    const options = state.availableModes;
    const currentModeId = state.currentModeId;

    const legacy = computeLegacyRequestedModeIdFromPermissionMode(params.metadata, options);
    const requestedModeId = modeOverride ? modeOverride.modeId : legacy;
    const effectiveModeId = requestedModeId ?? currentModeId;

    const currentMode = options.find((mode) => mode.id === currentModeId) ?? null;
    const requestedMode = requestedModeId ? options.find((mode) => mode.id === requestedModeId) ?? null : null;
    const effectiveMode = options.find((mode) => mode.id === effectiveModeId) ?? null;
    const isPending = Boolean(requestedModeId && requestedModeId !== currentModeId);

    return {
        agentId: params.agentId,
        options,
        currentModeId,
        currentModeName: currentMode?.name ?? currentModeId ?? tLoose('agentInput.mode.sectionTitle'),
        requestedModeId,
        isExplicitOverride: modeOverride?.modeId != null,
        requestedModeName: requestedMode?.name ?? requestedModeId,
        effectiveModeId,
        effectiveModeName: effectiveMode?.name ?? effectiveModeId ?? tLoose('agentInput.mode.sectionTitle'),
        isPending,
    };
}

export function computeSessionModePickerControl(params: {
    agentId: string;
    metadata: Metadata | null | undefined;
}): SessionModePickerControl | null {
    const agentId = normalizeBundledAgentRoutingId(params.agentId);
    const state = readSessionModesState(params.metadata);
    const currentState = state && normalizeBundledAgentRoutingId(state.agentId) === agentId ? state : null;
    // An override belongs to this Agent while it has the current catalog or the catalog has yet to arrive.
    const modeOverride = !state || currentState ? readSessionModeOverride(params.metadata) : null;
    const control = currentState ? computeDynamicSessionModePickerControlInternal({ ...params, state: currentState, modeOverride }) : null;
    if (control || !supportsSessionModeOverrides(agentId)) return control;
    return computeStaticSessionModePickerControl({ ...params, agentId, modeOverride })
        ?? (modeOverride?.modeId ? createExplicitSessionModePickerControl({ agentId, modeId: modeOverride.modeId }) : null);
}

import { getAgentCore } from '@/agents/catalog/catalog';
import type { Metadata } from '@happier-dev/session-core/state';
import {
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    parsePermissionIntentAlias,
    readAcpSessionModeIntentFromMetadata,
    readMetadataAliasValue,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';
import { resolveRequestedSessionModeId } from '@happier-dev/protocol/actions/sessionModeIds';
import { tLoose } from '@/text';

import { parseSessionModeOverrideState } from './schema';
import { readSessionModesState } from './readSessionControlMetadata';

export function supportsSessionModeOverrides(agentId: string): boolean {
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
    if (hasNativeDefault && !getAgentCore(agentId)?.permissions.permissionModeMapping) return nativeOptions;
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

function computeStaticSessionModePickerControl(params: {
    agentId: string;
    metadata: Metadata | null | undefined;
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

    const modeOverride = readAcpSessionModeIntentFromMetadata((params.metadata as any) ?? {})
        ?? parseSessionModeOverrideState(
            readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY),
        );
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
}): SessionModePickerControl | null {
    const state = readSessionModesState(params.metadata);
    if (!state) return null;
    if (state.agentId !== params.agentId) return null;
    if (state.availableModes.length === 0) return null;

    const options = state.availableModes;
    const currentModeId = state.currentModeId;

    const modeOverride = readAcpSessionModeIntentFromMetadata((params.metadata as any) ?? {})
        ?? parseSessionModeOverrideState(
            readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY),
        );
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
    return computeDynamicSessionModePickerControlInternal(params)
        ?? (supportsSessionModeOverrides(params.agentId) ? computeStaticSessionModePickerControl(params) : null);
}

export const computeAcpSessionModePickerControl = computeSessionModePickerControl;

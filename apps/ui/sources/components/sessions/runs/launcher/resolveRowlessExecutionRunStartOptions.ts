import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { ExecutionRunTeamCredentialSessionBindingConsentV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { PluginSourceCustodyV1Schema, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { findSpawnConfigOptionAliasConflicts, mergeSpawnConfigOptionAliases, type SpawnConfigOptionValue } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { normalizeConnectedServiceSelectionInput } from '@happier-dev/protocol/connect/normalizeConnectedServiceSelectionInput';
import type { ExecutionRunStartRequest } from '@happier-dev/protocol/execution/runs/index';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';

import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';

import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';

type RowlessRunStartOptions = Pick<ExecutionRunStartRequest,
    | 'backendTarget'
    | 'roleId'
    | 'permissionMode'
    | 'notifyParentOnCompletion'
    | 'profileId'
    | 'modelId'
    | 'modelSelection'
    | 'sessionConfigOptionOverrides'
    | 'connectedServices'
    | 'connectedServicesDefaultServiceIds'
    | 'secretReferenceOverlay'
    | 'teamCredentialModel'
    | 'teamCredentialSessionBindingConsent'
> & Readonly<{ profileSourceCustody?: PluginSourceCustodyV1 }>;

function readConfigOptions(value: unknown): Record<string, SpawnConfigOptionValue> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.every(([, item]) => typeof item === 'string'
        || typeof item === 'boolean'
        || item === null
        || (typeof item === 'number' && Number.isFinite(item)))) return undefined;
    return Object.fromEntries(entries) as Record<string, SpawnConfigOptionValue>;
}

export function resolveRowlessExecutionRunStartOptions(params: Readonly<{
    choice: ExecutionRunLauncherBackendChoice;
    input: Readonly<Record<string, unknown>>;
}>): { ok: true; options: RowlessRunStartOptions } | { ok: false } {
    if (params.choice.disabled) return { ok: false };
    const permissionMode = typeof params.input.permissionMode === 'string' ? params.input.permissionMode : null;
    if (!permissionMode) return { ok: false };
    const roleId = params.input.roleId;
    if (roleId !== undefined && (typeof roleId !== 'string' || !roleId.trim())) return { ok: false };
    const notifyParentOnCompletion = params.input.notifyParentOnCompletion;
    if (notifyParentOnCompletion !== undefined && typeof notifyParentOnCompletion !== 'boolean') return { ok: false };
    const profileId = typeof params.input.profileId === 'string' && params.input.profileId.trim() ? params.input.profileId : null;
    const profileSourceCustody = params.input.profileSourceCustody === undefined
        ? null
        : PluginSourceCustodyV1Schema.safeParse(params.input.profileSourceCustody);
    if (profileSourceCustody && !profileSourceCustody.success) return { ok: false };
    if (Boolean(profileId) !== Boolean(profileSourceCustody?.success)) return { ok: false };
    const modelId = typeof params.input.modelId === 'string' && params.input.modelId.trim() ? params.input.modelId.trim() : null;
    const modelSelection = params.input.modelSelection === undefined
        ? null
        : ProviderBoundModelRefSchema.nullable().safeParse(params.input.modelSelection);
    if (modelSelection && !modelSelection.success) return { ok: false };
    if (modelSelection?.success && modelSelection.data !== null && (
        !backendTargetKeysMatch(modelSelection.data.agentTargetKey, params.choice.backendTarget)
        || (modelId !== null && modelId !== modelSelection.data.modelId)
    )) return { ok: false };
    const parsedCanonical = params.input.sessionConfigOptionOverrides === undefined
        ? null
        : AcpConfigOptionOverridesV1Schema.safeParse(params.input.sessionConfigOptionOverrides);
    if (parsedCanonical && !parsedCanonical.success) return { ok: false };
    const configOptions = readConfigOptions(params.input.configOptions);
    if (params.input.configOptions !== undefined && !configOptions) return { ok: false };
    const canonicalOverrides = parsedCanonical?.success ? parsedCanonical.data : undefined;
    if (findSpawnConfigOptionAliasConflicts({
        ...(canonicalOverrides ? { sessionConfigOptionOverrides: canonicalOverrides } : {}),
        ...(configOptions ? { configOptions } : {}),
    }).length > 0) return { ok: false };
    const sessionConfigOptionOverrides = mergeSpawnConfigOptionAliases({
        ...(canonicalOverrides ? { sessionConfigOptionOverrides: canonicalOverrides } : {}),
        ...(configOptions ? { configOptions } : {}),
    });
    const byTarget = params.input.connectedServicesByBackendTargetKey;
    if (byTarget !== undefined && (!byTarget || typeof byTarget !== 'object' || Array.isArray(byTarget))) {
        return { ok: false };
    }
    const targetValue = byTarget && typeof byTarget === 'object' && !Array.isArray(byTarget)
        ? (byTarget as Record<string, unknown>)[params.choice.targetKey]
        : undefined;
    const connectedSelection = targetValue !== undefined ? targetValue : params.input.connectedServices;
    const connectedServices = connectedSelection === undefined
        ? null
        : normalizeConnectedServiceSelectionInput(connectedSelection);
    if (connectedServices && !connectedServices.ok) return { ok: false };
    const secretReferenceOverlay = params.input.secretReferenceOverlay === undefined
        ? null
        : SecretReferenceOverlayV1Schema.safeParse(params.input.secretReferenceOverlay);
    if (secretReferenceOverlay && !secretReferenceOverlay.success) return { ok: false };
    const teamCredentialModel = params.input.teamCredentialModel === undefined
        ? null
        : TeamCredentialProviderModelSelectionV1Schema.safeParse(params.input.teamCredentialModel);
    if (teamCredentialModel && !teamCredentialModel.success) return { ok: false };
    if (teamCredentialModel?.success && (
        modelSelection?.success
        || teamCredentialModel.data.agentTargetKey !== params.choice.targetKey
        || teamCredentialModel.data.modelId !== modelId
    )) return { ok: false };
    const teamCredentialSessionBindingConsent = params.input.teamCredentialSessionBindingConsent === undefined
        ? null
        : ExecutionRunTeamCredentialSessionBindingConsentV1Schema.safeParse(
            params.input.teamCredentialSessionBindingConsent,
        );
    if (teamCredentialSessionBindingConsent && !teamCredentialSessionBindingConsent.success) return { ok: false };
    if (teamCredentialSessionBindingConsent?.success) {
        if (!teamCredentialModel?.success) return { ok: false };
        const consent = teamCredentialSessionBindingConsent.data;
        const selection = teamCredentialModel.data;
        if (
            consent.teamId !== selection.teamId
            || consent.resourceId !== selection.resourceId
            || consent.expectedResourceRevision !== selection.expectedResourceRevision
        ) return { ok: false };
    }
    return {
        ok: true,
        options: {
            backendTarget: params.choice.backendTarget,
            // Identity only: the target Session's admission resolves the role and stamps its engine.
            ...(roleId !== undefined ? { roleId: roleId.trim() } : {}),
            permissionMode,
            ...(notifyParentOnCompletion !== undefined ? { notifyParentOnCompletion } : {}),
            ...(profileId && profileSourceCustody?.success
                ? { profileId, profileSourceCustody: profileSourceCustody.data }
                : {}),
            ...(modelId ? { modelId } : {}),
            ...(modelSelection?.success ? { modelSelection: modelSelection.data } : {}),
            ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
            ...(connectedServices?.ok && connectedServices.bindings !== undefined ? { connectedServices: connectedServices.bindings } : {}),
            ...(connectedServices?.ok && connectedServices.defaultServiceIds.length > 0
                ? { connectedServicesDefaultServiceIds: [...connectedServices.defaultServiceIds] }
                : {}),
            ...(secretReferenceOverlay?.success
                ? { secretReferenceOverlay: secretReferenceOverlay.data }
                : {}),
            ...(teamCredentialModel?.success
                ? { teamCredentialModel: teamCredentialModel.data }
                : {}),
            ...(teamCredentialSessionBindingConsent?.success
                ? { teamCredentialSessionBindingConsent: teamCredentialSessionBindingConsent.data }
                : {}),
        },
    };
}

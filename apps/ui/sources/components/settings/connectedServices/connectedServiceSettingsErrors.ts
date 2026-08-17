import { t } from '@/text';

type ErrorLike = Readonly<{
    code?: unknown;
    message?: unknown;
    status?: unknown;
    generation?: unknown;
    resetAtMs?: unknown;
}>;

function asErrorLike(error: unknown): ErrorLike {
    return error && typeof error === 'object' ? error as ErrorLike : {};
}

export function readConnectedServiceSettingsErrorCode(error: unknown): string | null {
    const errorLike = asErrorLike(error);
    if (typeof errorLike.code === 'string' && errorLike.code.trim().length > 0) {
        return errorLike.code;
    }
    if (typeof errorLike.message === 'string' && /^connect[_a-z0-9]+$/i.test(errorLike.message)) {
        return errorLike.message;
    }
    return null;
}

export function isConnectedServiceRuntimeCooldownError(error: unknown): boolean {
    return readConnectedServiceSettingsErrorCode(error) === 'connect_group_profile_runtime_cooldown';
}

export function isConnectedServiceCredentialReferencedByGroupError(error: unknown): boolean {
    return readConnectedServiceSettingsErrorCode(error) === 'connect_credential_referenced_by_group';
}

export function readConnectedServiceRuntimeCooldownResetAtMs(error: unknown): number | null {
    const value = asErrorLike(error).resetAtMs;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatResetAt(error: unknown): string {
    const resetAtMs = readConnectedServiceRuntimeCooldownResetAtMs(error);
    return resetAtMs === null ? t('connectedServices.errors.unknownResetTime') : new Date(resetAtMs).toLocaleString();
}

export function resolveConnectedServiceSettingsErrorMessage(error: unknown): string {
    const errorLike = asErrorLike(error);
    const code = readConnectedServiceSettingsErrorCode(error);

    switch (code) {
        case 'connected_account_configuration_invalid':
            return t('connectedServices.account.configurationInvalid');
        case 'connect_credential_referenced_by_group':
            return t('connectedServices.errors.credentialReferencedByGroup');
        case 'connect_credential_mutation_superseded':
            return t('connectedServices.errors.generic');
        case 'connect_group_profile_runtime_cooldown':
            return t('connectedServices.errors.runtimeCooldown', { time: formatResetAt(error) });
        case 'connect_group_generation_conflict':
        case 'connect_group_incarnation_conflict':
        case 'connect_group_runtime_state_revision_conflict':
        case 'connect_group_source_revision_conflict':
            return typeof errorLike.generation === 'number'
                ? t('connectedServices.errors.generationConflictWithGeneration', { generation: errorLike.generation })
                : t('connectedServices.errors.generationConflict');
        case 'connect_group_generation_required':
            return t('connectedServices.errors.generationRequired');
        case 'connect_group_not_found':
            return t('connectedServices.errors.groupNotFound');
        case 'connect_group_member_not_found':
            return t('connectedServices.errors.groupMemberNotFound');
        case 'connect_group_member_profile_not_found':
            return t('connectedServices.errors.profileNotFound');
        case 'connect_group_active_profile_not_member':
            return t('connectedServices.errors.activeProfileNotMember');
        case 'connect_group_fallback_disabled':
            return t('connectedServices.errors.fallbackDisabled');
        case 'connect_group_duplicate_member':
        case 'connect_group_member_already_exists':
            return t('connectedServices.errors.duplicateMember');
        case 'connect_group_already_exists':
            return t('connectedServices.errors.groupAlreadyExists');
        case 'connect_group_invalid':
            return t('connectedServices.errors.invalidGroup');
        case 'connected_service_request_failed':
            break;
        default:
            if (code) return t('connectedServices.errors.generic');
    }

    if (typeof errorLike.status === 'number') {
        return t('connectedServices.errors.requestFailedWithStatus', { status: errorLike.status });
    }
    return t('connectedServices.errors.generic');
}

export function resolveConnectedServiceRuntimeCooldownOverrideBody(error: unknown): string {
    return t('connectedServices.errors.runtimeCooldownOverrideBody', { time: formatResetAt(error) });
}

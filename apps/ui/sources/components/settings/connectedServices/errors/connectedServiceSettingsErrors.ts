import { t } from '@/text';
import {
  isConnectedServiceApiErrorCode,
  readConnectedServiceApiErrorFields,
} from '@/sync/api/account/connectedServiceApiError';

import { resolveConnectedServiceNetworkErrorMessage } from './connectedServiceNetworkErrorMessage';

function isRawConnectedServiceMessage(message: string): boolean {
  return message.startsWith('connect_')
    || message.startsWith('Failed connected-service group request:');
}

function formatResetTime(resetAtMs: number | undefined): string | null {
  return typeof resetAtMs === 'number' && Number.isFinite(resetAtMs)
    ? new Date(resetAtMs).toLocaleString()
    : null;
}

export function isConnectedServiceRuntimeCooldownError(error: unknown): boolean {
  return isConnectedServiceApiErrorCode(error, 'connect_group_profile_runtime_cooldown');
}

export function isConnectedServiceCredentialReferencedByGroupError(error: unknown): boolean {
  return isConnectedServiceApiErrorCode(error, 'connect_credential_referenced_by_group');
}

export function isConnectedServiceCredentialMutationSupersededError(error: unknown): boolean {
  return isConnectedServiceApiErrorCode(error, 'connect_credential_mutation_superseded');
}

export async function refreshConnectedServiceProfileAfterSupersededMutation(
  error: unknown,
  refreshProfile: () => Promise<unknown>,
): Promise<void> {
  if (isConnectedServiceCredentialMutationSupersededError(error)) {
    await refreshProfile();
  }
}

export function resolveConnectedServiceRuntimeCooldownOverridePrompt(error: unknown): Readonly<{
  title: string;
  body: string;
  confirmText: string;
  cancelText: string;
}> {
  const fields = readConnectedServiceApiErrorFields(error);
  const reset = formatResetTime(fields?.resetAtMs);
  return {
    title: t('connectedServices.detail.errors.runtimeCooldownOverrideTitle'),
    body: reset
      ? t('connectedServices.detail.errors.runtimeCooldownOverrideBody', { reset })
      : t('connectedServices.detail.errors.runtimeCooldownOverrideBodyWithoutReset'),
    confirmText: t('connectedServices.detail.errors.runtimeCooldownOverrideConfirm'),
    cancelText: t('common.cancel'),
  };
}

export function resolveConnectedServiceSettingsErrorMessage(error: unknown): string {
  const networkMessage = resolveConnectedServiceNetworkErrorMessage(error);
  if (networkMessage) return networkMessage;
  const fields = readConnectedServiceApiErrorFields(error);
  if (fields) {
    const reset = formatResetTime(fields.resetAtMs);
    switch (fields.code) {
      case 'connect_service_unsupported':
        return t('connectedServices.detail.errors.serviceUnsupportedServer');
      case 'connect_credential_referenced_by_group':
        return t('connectedServices.detail.errors.credentialReferencedByGroup');
      case 'connect_credential_not_found':
        return t('connectedServices.detail.errors.credentialNotFound');
      case 'connect_credential_request_failed':
        return t('connectedServices.detail.errors.credentialRequestFailed');
      case 'connect_credential_mutation_superseded':
        return t('connectedServices.detail.errors.credentialRequestFailed');
      case 'connect_group_profile_runtime_cooldown':
        return reset
          ? t('connectedServices.detail.errors.runtimeCooldown', { reset })
          : t('connectedServices.detail.errors.runtimeCooldownWithoutReset');
      case 'connect_group_generation_conflict':
        return t('connectedServices.detail.errors.generationConflict');
      case 'connect_group_not_found':
        return t('connectedServices.detail.errors.groupNotFound');
      case 'connect_group_member_not_found':
        return t('connectedServices.detail.errors.memberNotFound');
      case 'connect_group_member_profile_not_found':
      case 'connect_group_profile_not_found':
      case 'connect_profile_not_found':
        return t('connectedServices.detail.errors.profileNotFound');
      case 'connect_group_fallback_disabled':
        return t('connectedServices.detail.errors.fallbackDisabled');
      case 'connect_group_runtime_fallback_unsupported':
        return t('connectedServices.detail.groupActions.runtimeFallbackUnsupported');
      case 'connect_group_request_failed':
        return t('connectedServices.detail.errors.groupRequestFailed');
      default:
        return t('connectedServices.detail.errors.requestFailed');
    }
  }

  if (error instanceof Error && error.message) {
    return isRawConnectedServiceMessage(error.message)
      ? t('connectedServices.detail.errors.requestFailed')
      : error.message;
  }

  return t('common.error');
}

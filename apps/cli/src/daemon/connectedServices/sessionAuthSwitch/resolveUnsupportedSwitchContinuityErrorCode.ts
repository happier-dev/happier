import type { SessionConnectedServiceAuthSwitchErrorCode } from './switchSessionConnectedServiceAuth';

type UnsupportedSwitchContinuityErrorCode = Extract<
  SessionConnectedServiceAuthSwitchErrorCode,
  | 'provider_state_sharing_required'
  | 'provider_state_sharing_unavailable'
  | 'provider_state_sharing_settings_unavailable'
  | 'provider_session_state_unavailable_for_resume'
  | 'continuity_unsupported'
  | 'unsupported_service'
>;

export function resolveUnsupportedSwitchContinuityErrorCode(
  reason: string | null | undefined,
): UnsupportedSwitchContinuityErrorCode {
  switch (reason) {
    case 'unsupported_service':
      return 'unsupported_service';
    case 'provider_state_sharing_required':
      return 'provider_state_sharing_required';
    case 'provider_state_sharing_unavailable':
      return 'provider_state_sharing_unavailable';
    case 'provider_state_sharing_settings_unavailable':
      return 'provider_state_sharing_settings_unavailable';
    case 'provider_session_state_unavailable_for_resume':
      return 'provider_session_state_unavailable_for_resume';
    default:
      return 'continuity_unsupported';
  }
}

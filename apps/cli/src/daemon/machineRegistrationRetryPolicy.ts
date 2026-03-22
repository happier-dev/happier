import { isMachineContentPublicKeyMismatchError } from '@/api/api';

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  const status = response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

export function shouldRetryMachineRegistrationError(error: unknown): boolean {
  if (isMachineContentPublicKeyMismatchError(error)) return false;
  const status = getStatusCode(error);
  if (status === 401 || status === 403) return false;
  return true;
}

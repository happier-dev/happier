import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const showDaemonUnavailableAlert = vi.hoisted(() => vi.fn());

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
  showDaemonUnavailableAlert,
}));

describe('tryShowDaemonUnavailableAlertForScmOperationFailure', () => {
  it('returns true and shows alert only for BACKEND_UNAVAILABLE', async () => {
    showDaemonUnavailableAlert.mockReset();
    const { tryShowDaemonUnavailableAlertForScmOperationFailure } = await import('./scmDaemonUnavailableAlert');

    const onRetry = vi.fn();
    const shouldContinue = () => true;
    const shown = tryShowDaemonUnavailableAlertForScmOperationFailure({
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      onRetry,
      shouldContinue,
    });

    expect(shown).toBe(true);
    expect(showDaemonUnavailableAlert).toHaveBeenCalledWith(expect.objectContaining({
      titleKey: 'errors.daemonUnavailableTitle',
      bodyKey: 'errors.daemonUnavailableBody',
      onRetry,
      shouldContinue,
    }));
  });

  it('returns false for FEATURE_UNSUPPORTED (even though message text may be reused elsewhere)', async () => {
    showDaemonUnavailableAlert.mockReset();
    const { tryShowDaemonUnavailableAlertForScmOperationFailure } = await import('./scmDaemonUnavailableAlert');

    const shown = tryShowDaemonUnavailableAlertForScmOperationFailure({
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
      onRetry: vi.fn(),
    });

    expect(shown).toBe(false);
    expect(showDaemonUnavailableAlert).not.toHaveBeenCalled();
  });
});

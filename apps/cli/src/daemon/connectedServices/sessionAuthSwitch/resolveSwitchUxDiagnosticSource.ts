import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';

import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';

export function resolveSwitchUxDiagnosticSource(
  reason: ConnectedServiceSessionAuthSwitchReason | undefined,
): ConnectedServiceUxDiagnosticV1['source'] {
  switch (reason) {
    case 'automatic_runtime_failure':
      return 'runtime_auth_recovery';
    case 'pre_turn_group_policy':
      return 'usage_limit_recovery' as ConnectedServiceUxDiagnosticV1['source'];
    case 'manual':
    case undefined:
      return 'manual_auth_switch';
  }
}

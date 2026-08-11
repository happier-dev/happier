import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export type ClaudeConnectedServiceRuntimeAuthSwitchPlan = Readonly<{
  supportsHotApply: boolean;
  recovery: 'restart_rematerialize' | 'shared_group_auth_surface_rewrite';
  envKeys: ReadonlyArray<'ANTHROPIC_API_KEY' | 'CLAUDE_CONFIG_DIR'>;
  materialization:
    | 'anthropic_api_key'
    | 'claude_code_native_credentials_file';
}>;

export function resolveClaudeConnectedServiceRuntimeAuthSwitchPlan(
  record: ConnectedServiceCredentialRecordV1,
): ClaudeConnectedServiceRuntimeAuthSwitchPlan {
  if (record.serviceId === 'anthropic') {
    return {
      supportsHotApply: false,
      recovery: 'restart_rematerialize',
      envKeys: ['ANTHROPIC_API_KEY'],
      materialization: 'anthropic_api_key',
    };
  }
  return {
    supportsHotApply: true,
    recovery: 'shared_group_auth_surface_rewrite',
    envKeys: ['CLAUDE_CONFIG_DIR'],
    materialization: 'claude_code_native_credentials_file',
  };
}

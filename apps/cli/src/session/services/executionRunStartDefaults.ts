import type { ExecutionRunIntent } from '@happier-dev/protocol';

export function defaultPermissionModeForExecutionRunIntent(intent: ExecutionRunIntent): string {
  if (intent === 'delegate') return 'workspace_write';
  return 'read_only';
}

export function defaultRunClassForExecutionRunIntent(intent: ExecutionRunIntent): 'bounded' | 'long_lived' {
  if (intent === 'voice_agent') return 'long_lived';
  return 'bounded';
}

export function defaultIoModeForExecutionRunIntent(intent: ExecutionRunIntent): 'request_response' | 'streaming' {
  if (intent === 'voice_agent') return 'streaming';
  return 'request_response';
}

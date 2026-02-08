import { SDKToLogConverter } from './sdkToLogConverter';

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export const conversionContext = {
  sessionId: 'test-session-123',
  cwd: '/test/project',
  version: '1.0.0',
  gitBranch: 'main',
};

export function createConverter(
  responses?: Map<string, { approved: boolean; mode?: PermissionMode; reason?: string }>,
): SDKToLogConverter {
  return new SDKToLogConverter(conversionContext, responses);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

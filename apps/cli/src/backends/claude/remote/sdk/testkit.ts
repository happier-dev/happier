import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';

export function makeMode(overrides?: Partial<EnhancedMode>): EnhancedMode {
  return {
    permissionMode: 'default',
    ...overrides,
  };
}

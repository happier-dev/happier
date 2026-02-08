import type { EnhancedMode } from '@/backends/claude/loop';

export function makeMode(overrides?: Partial<EnhancedMode>): EnhancedMode {
  return {
    permissionMode: 'default',
    ...overrides,
  };
}

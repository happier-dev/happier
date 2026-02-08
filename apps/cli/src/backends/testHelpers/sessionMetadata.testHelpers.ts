import type { Metadata } from '@/api/types';

export function createTestMetadata(overrides?: Partial<Metadata>): Metadata {
  return {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happy',
    happyLibDir: '/tmp/.happy/lib',
    happyToolsDir: '/tmp/.happy/tools',
    flavor: 'codex',
    ...overrides,
  };
}

import { describe, expect, it } from 'vitest';

import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCatalogProviderAcpRuntime } from './createCatalogProviderAcpRuntime';

function createParams() {
  return {
    provider: 'qwen' as const,
    loggerLabel: 'QwenACP',
    directory: '/tmp',
    session: createApiSessionClientFixture(),
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
  };
}

describe('createCatalogProviderAcpRuntime session identity ownership', () => {
  it('constructs the manifest-backed identity publisher for a resumable agent', () => {
    const runtime = createCatalogProviderAcpRuntime({
      ...createParams(),
      sessionIdentity: { kind: 'manifest-metadata' },
    });

    expect(runtime.getSessionId()).toBeNull();
  });

  it('rejects runtime-only identity when the manifest advertises vendor resume', () => {
    expect(() => createCatalogProviderAcpRuntime({
      ...createParams(),
      sessionIdentity: {
        kind: 'runtime-only',
        reason: 'vendor-resume-unsupported',
      },
    })).toThrow(/advertises vendor resume/i);
  });
});

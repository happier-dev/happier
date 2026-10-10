import { describe, expect, it } from 'vitest';

import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import { prepareAcpCatalogTransferV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import { createAcpTransportHandlerFromDefinition } from '@/agent/acp/runtime/definition/transport';

// Prospective 0.2 source: 37a6541578749067b49d4579be8c752c9591b8c8,
// packages/protocol/src/acpCatalog/settingsV1.ts and configured/createConfiguredAcpBackend.ts.
const predecessorSource = {
  acpCatalogSettingsV1: {
    v: 2,
    backends: [{
      id: 'my-kiro', name: 'my-kiro', title: 'My Kiro', command: 'custom-kiro-cli', args: ['acp'],
      env: { REGION: { t: 'literal', v: 'eu' } },
      auth: { support: 'login_terminal', statusCommand: ['whoami', '--format', 'json'], parser: 'kiroWhoamiJson' },
      transportProfile: 'kiro', defaultMode: 'default', defaultModel: 'model-pro',
      capabilities: { supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'yes', supportsConfigOptions: 'unknown', promptImageSupport: 'no' },
      createdAt: 1, updatedAt: 2,
    }],
  },
};

describe('configured ACP predecessor transport', () => {
  it('preserves optional native notification suppression without suppressing a neighboring real error', () => {
    const prepared = prepareAcpCatalogTransferV2({ rawSettings: predecessorSource, sourceSettingsVersion: 7, kiroStderrRules: KIRO_ACP_STDERR_RULES });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    const definition = prepared.record.definitions[0]!;
    const transport = createAcpTransportHandlerFromDefinition({ backendId: definition.id, stderrRules: definition.runtime?.stderrRules });
    const context = { activeToolCalls: new Set<string>(), hasActiveInvestigation: false };

    // Exact predecessor specimen: apps/cli/src/backends/kiro/acp/transport.test.ts.
    expect(transport.handleStderr?.(`Error handling notification {"jsonrpc":"2.0","method":"_kiro.dev/metadata"} {"code":-32601,"message":"\\"Method not found\\": _kiro.dev/metadata"}`, context))
      .toEqual({ message: null, suppress: true });
    expect(transport.handleStderr?.('Error: unknown command acp', context))
      .toMatchObject({ message: { type: 'status', status: 'error' }, suppress: false });
  });
});

import { describe, expect, it } from 'vitest';

import { handleConfiguredAcpCatalogCliCommand } from './handleCatalogCliCommand';

describe('handleConfiguredAcpCatalogCliCommand', () => {
  it('refuses a command that does not select a configured definition', async () => {
    await expect(handleConfiguredAcpCatalogCliCommand({
      args: ['acp-catalog'],
      rawArgv: ['acp-catalog'],
      terminalRuntime: null,
    })).rejects.toThrow('--backend');
  });
});

import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';

describe('providers: ACP permission prompt matrix in provider specs', () => {
  it('defines toolPermissionPromptsByMode for each ACP provider', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const acpProviders = providers.filter((provider) => provider.protocol === 'acp');
    expect(acpProviders.length).toBeGreaterThan(0);

    for (const provider of acpProviders) {
      const promptsByMode = (provider.permissions as any)?.acp?.toolPermissionPromptsByMode;
      const outsideWriteByMode = (provider.permissions as any)?.acp?.outsideWorkspaceWriteAllowedByMode;
      const outsideWriteMustCompleteByMode = (provider.permissions as any)?.acp?.outsideWorkspaceWriteMustCompleteByMode;
      expect(promptsByMode, `${provider.id} is missing permissions.acp.toolPermissionPromptsByMode`).toBeTruthy();
      expect(outsideWriteByMode, `${provider.id} is missing permissions.acp.outsideWorkspaceWriteAllowedByMode`).toBeTruthy();
      expect(
        outsideWriteMustCompleteByMode,
        `${provider.id} is missing permissions.acp.outsideWorkspaceWriteMustCompleteByMode`,
      ).toBeTruthy();
      expect(typeof promptsByMode.default).toBe('boolean');
      expect(typeof promptsByMode['safe-yolo']).toBe('boolean');
      expect(typeof promptsByMode['read-only']).toBe('boolean');
      expect(typeof promptsByMode.yolo).toBe('boolean');
      expect(typeof outsideWriteByMode.default).toBe('boolean');
      expect(typeof outsideWriteByMode['safe-yolo']).toBe('boolean');
      expect(typeof outsideWriteByMode['read-only']).toBe('boolean');
      expect(typeof outsideWriteByMode.yolo).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode.default).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode['safe-yolo']).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode['read-only']).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode.yolo).toBe('boolean');
    }
  });
});

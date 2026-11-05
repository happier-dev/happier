import { describe, expect, it, vi } from 'vitest';

describe('Action catalog initialization', () => {
  it.each(['catalog', 'artifact', 'machine-services', 'plugin-ui', 'plugin-surface', 'drop-target', 'workflow', 'legacy-automation'] as const)(
    'allows %s to load first and retains the same callable Action vocabulary',
    async (entry) => {
      vi.resetModules();
      if (entry === 'catalog') await import('./actionIds.js');
      if (entry === 'artifact') await import('../artifacts/artifactActionsV1.js');
      if (entry === 'machine-services') await import('./specs/machine/services.js');
      if (entry === 'plugin-ui') await import('../plugins/contributions/ui/v2.js');
      if (entry === 'plugin-surface') await import('./pluginActionSurface.js');
      if (entry === 'drop-target') await import('../plugins/contributions/entityDragDrop.js');
      if (entry === 'workflow') await import('../workflows/actionsV1.js');
      if (entry === 'legacy-automation') await import('../automations/automationLegacyWorkflowV1.js');
      const { ActionIdSchema } = await import('./actionIds.js');
      const { PluginInvocableActionIdSchema } = await import('./pluginActionSurface.js');
      const { MACHINE_SERVICE_ACTION_IDS } = await import('../local/services/actionIdsV1.js');
      expect(ActionIdSchema.parse('artifact.create')).toBe('artifact.create');
      for (const actionId of MACHINE_SERVICE_ACTION_IDS) {
        expect(ActionIdSchema.parse(actionId)).toBe(actionId);
      }
      expect(PluginInvocableActionIdSchema.parse('artifact.public_link.create')).toBe('artifact.public_link.create');
    },
  );
});

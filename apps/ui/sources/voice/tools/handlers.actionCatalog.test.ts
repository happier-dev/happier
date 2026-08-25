import { describe, expect, it } from 'vitest';

import {
  formatQualifiedPluginActionId,
  getActionSpec,
  type ActionDefinitionV1,
} from '@happier-dev/protocol';

import { createVoiceToolHandlers } from './handlers';

describe('Voice Action reference catalog', () => {
  it('composes current contributed Actions into the existing action.spec tools', async () => {
    const contributedAction: ActionDefinitionV1 = {
      kindVersion: 1,
      id: formatQualifiedPluginActionId({ pluginId: 'acme.triage', localId: 'file-ticket' }),
      title: 'File ticket',
      description: 'Files a ticket for the selected issue.',
      safety: 'safe',
      approval: { result: 'none' },
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: true,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    };
    const handlers = createVoiceToolHandlers({
      resolveSessionId: () => null,
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => undefined,
        listCurrentContributedActionDefinitions: () => [contributedAction],
      },
    });
    const searchToolName = getActionSpec('action.spec.search').bindings?.voiceClientToolName;
    if (!searchToolName) throw new Error('missing action.spec.search Voice binding');

    const result = JSON.parse(await handlers[searchToolName]!({ query: 'file ticket' }));

    expect(result.ok).toBe(true);
    expect(result.actionSpecs).toContainEqual(expect.objectContaining({
      id: contributedAction.id,
      title: contributedAction.title,
    }));
  });
});

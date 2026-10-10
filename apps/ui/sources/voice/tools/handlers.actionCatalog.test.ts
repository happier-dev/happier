import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import {
  formatQualifiedPluginActionId,
  getActionSpec,
  type ActionDefinitionV1,
} from '@happier-dev/protocol';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { createVoiceToolHandlers, resolveVoiceToolEffectClass } = await import('./handlers');

describe('Voice Action reference catalog', () => {
  beforeEach(async () => { await home.reset(); });
  afterEach(async () => { await home.reset(); });
  it.each(['localServices_actions_copyUrl', 'localServices_actions_openPreview'] as const)(
    'does not advertise %s when the permission receipt has no answering clipboard or navigation client', toolName => {
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      expect(handlers[toolName]).toBeUndefined();
    });
  it.each(['localServices_launcher_start', 'localServices_actions_stopManaged'] as const)(
    'routes %s through the actual Action input boundary and retains mutation custody classification', async toolName => {
      // The front door captures an actual signed-in Home before dispatch.
      // Seed its credential/network boundaries, not an internal executor.
      const serverId = await home.addHome({ name: 'Service Home', serverUrl: 'https://service-home.test', accountId: 'account-a', currentAccount: true });
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      const handler = handlers[toolName];
      expect(handler).toBeTypeOf('function');
      expect(resolveVoiceToolEffectClass(toolName)).toBe('mutation');
      // No internal Action executor replacement: invalid semantic input must
      // settle before a Machine effect can occur, even without a selected Session.
      expect(JSON.parse(await handler!({}, { effectId: 'voice-service-effect', serverId })))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
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

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.actionSpecs).toContainEqual(expect.objectContaining({
      id: contributedAction.id,
      title: contributedAction.title,
    }));
  });
});

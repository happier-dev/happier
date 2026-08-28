import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';

describe('current UI context host ActionSpecs', () => {
  it('publishes the stable read, opaque-command, and generic Action bindings', () => {
    const read = getActionSpec('ui.current_context.read' as never);
    const invoke = getActionSpec('ui.current_context.command.invoke' as never);
    const invokeAction = getActionSpec('action.invoke' as never);

    const voiceOnly = {
      ui: false,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      api: false,
      plugin: false,
    };
    expect(read).toMatchObject({
      id: 'ui.current_context.read',
      sideEffectClass: 'read',
      safety: 'safe',
      bindings: { voiceClientToolName: 'readCurrentUiContext' },
    });
    expect(read.surfaces).toEqual(voiceOnly);
    expect(read.inputSchema.safeParse({}).success).toBe(true);
    expect(read.outputSchema?.safeParse({
      navigation: { area: 'workspace', screen: 'session', title: 'Current session' },
      commands: [{ id: 'current-ui:1:0', title: 'Open details' }],
    }).success).toBe(true);

    expect(invoke).toMatchObject({
      id: 'ui.current_context.command.invoke',
      sideEffectClass: 'external',
      safety: 'safe',
      bindings: { voiceClientToolName: 'invokeCurrentUiCommand' },
    });
    expect(invoke.surfaces).toEqual(voiceOnly);
    expect(invoke.inputSchema.safeParse({ commandId: 'current-ui:1:0' }).success).toBe(true);
    expect(invoke.inputSchema.safeParse({ command: { kind: 'executeAction' } }).success).toBe(false);

    expect(invokeAction).toMatchObject({
      id: 'action.invoke',
      sideEffectClass: 'external',
      safety: 'safe',
      bindings: { voiceClientToolName: 'invokeAction' },
    });
    expect(invokeAction.surfaces).toEqual({
      ...voiceOnly,
      api: true,
      plugin: true,
    });
    expect(invokeAction.inputSchema.safeParse({
      action: { pluginId: 'acme.plugin', localId: 'open-details' },
      input: { source: 'voice' },
    }).success).toBe(true);
    expect(invokeAction.inputSchema.safeParse({
      action: { localId: 'open-details' },
    }).success).toBe(false);
  });
});

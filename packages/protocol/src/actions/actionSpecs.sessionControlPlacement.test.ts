import { describe, expect, it } from 'vitest';

// Source transformation belongs to collection, not the operation's test deadline.
let catalog: typeof import('./actionSpecs.js') | undefined;
let initializationError: unknown;
try {
  catalog = await import('./actionSpecs.js');
} catch (error) {
  initializationError = error;
}

describe('Session control catalog initialization', () => {
  it.each([
    'session.messages.pins', 'desktop.displays.list', 'desktop.notch.set',
    'desktop.windows.open', 'media.annotation.read', 'media.annotation.apply',
  ] as const)('publishes the authored client placement for %s', actionId => {
    expect(initializationError).toBeUndefined();
    if (!catalog) throw new Error('The Action catalog did not initialize');
    expect(catalog.getActionSpec(actionId).executionPlacement).toBe('client');
  });

  it('places desired capability edits at Account metadata and preserves connected-account Session control', async () => {
    expect(initializationError).toBeUndefined();
    if (!catalog) throw new Error('The Action catalog did not initialize');
    const capabilities = catalog.getActionSpec('session.capabilities.set');
    expect(capabilities.executionPlacement).toBe('account');
    expect(capabilities.surfaces).toMatchObject({ ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true });
    const connected = catalog.getActionSpec('session.connected_services_auth.set');
    expect(connected.executionPlacement).toBe('session');
    expect(connected.surfaces).toMatchObject({ ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false });
  });
});

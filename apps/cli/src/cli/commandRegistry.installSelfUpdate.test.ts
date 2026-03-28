import { describe, expect, it } from 'vitest';

import { commandRegistry } from './commandRegistry';

describe('commandRegistry install/update aliases', () => {
  it('registers bug-report top-level command', () => {
    expect(commandRegistry['bug-report']).toBeTypeOf('function');
  });

  it('registers self-update top-level alias', () => {
    expect(commandRegistry['self-update']).toBeTypeOf('function');
  });

  it('registers install command namespace', () => {
    expect(commandRegistry.install).toBeTypeOf('function');
  });

  it('registers resume top-level command', () => {
    expect(commandRegistry.resume).toBeTypeOf('function');
  });

  it('registers session top-level command', () => {
    expect(commandRegistry.session).toBeTypeOf('function');
  });

  it('registers profiles command namespace + alias', () => {
    expect(commandRegistry.profiles).toBeTypeOf('function');
    expect(commandRegistry.profile).toBeTypeOf('function');
  });

  it('registers mcp command namespace', () => {
    expect(commandRegistry.mcp).toBeTypeOf('function');
  });

  it('registers bridge command namespace', () => {
    expect(commandRegistry.bridge).toBeTypeOf('function');
  });

  it('registers tools command namespace', () => {
    expect(commandRegistry.tools).toBeTypeOf('function');
  });

  it('registers built-in generic ACP agent commands', () => {
    expect(commandRegistry.customAcp).toBeTypeOf('function');
    expect(commandRegistry.kiro).toBeTypeOf('function');
  });

  it('registers the configured ACP catalog command namespace', () => {
    expect(commandRegistry['acp-catalog']).toBeTypeOf('function');
  });
});

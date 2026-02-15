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
});

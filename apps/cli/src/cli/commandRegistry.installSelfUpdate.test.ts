import { describe, expect, it } from 'vitest';

import { commandRegistry } from './commandRegistry';

describe('commandRegistry install/update aliases', () => {
  it('registers self-update top-level alias', () => {
    expect(commandRegistry['self-update']).toBeTypeOf('function');
  });

  it('registers install command namespace', () => {
    expect(commandRegistry.install).toBeTypeOf('function');
  });
});

import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Cursor agent definition', () => {
  it('keeps Cursor Happier tool delivery on the shell bridge until native MCP is validated', () => {
    expect(AGENT_DEFINITION.core.tools).toEqual({
      delivery: 'shell_bridge',
      support: 'experimental',
    });
  });
});

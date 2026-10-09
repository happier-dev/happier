import { describe, expect, it } from 'vitest';
import { CODEBUDDY_TERMINAL_SURFACE } from './contribution.js';

describe('CodeBuddy terminal', () => {
  it('lets the host resolve the CLI executable without launching it twice', () => {
    expect(CODEBUDDY_TERMINAL_SURFACE.resolveLaunch({
      sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
    })).toMatchObject({ argv: [], process: { stdio: 'inherit', windowsHide: true } });
  });
});

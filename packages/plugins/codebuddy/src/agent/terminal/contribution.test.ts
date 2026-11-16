import { describe, expect, it } from 'vitest';
import { CODEBUDDY_TERMINAL_SURFACE } from './contribution.js';

describe('CodeBuddy terminal', () => {
  it.each(['on', 'off'] as const)('selects only the native sandbox %s through launch settings', async nativeSandbox => {
    const launch = await CODEBUDDY_TERMINAL_SURFACE.resolveLaunch({
      sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
      configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'default', updatedAtMs: 0 }, nativeSandbox, options: {} },
    });
    expect(launch.argv).toEqual(['--settings', JSON.stringify({ sandbox: { enabled: nativeSandbox === 'on' } })]);
  });
  it('lets the host resolve the CLI executable without launching it twice', () => {
    expect(CODEBUDDY_TERMINAL_SURFACE.resolveLaunch({
      sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
    })).toMatchObject({ argv: [], process: { stdio: 'inherit', windowsHide: true } });
  });
});

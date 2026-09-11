import { describe, expect, it } from 'vitest';
import * as mod from '../index.js';

describe('browser control protocol v1', () => {
  it('accepts browser navigation commands and rejects shell-only address input commands', () => {
    expect(mod.BrowserCommandV1Schema.safeParse({
      kind: 'openView',
      commandId: 'command_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      target: {
        kind: 'localServicePreview',
        targetId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
      },
	      platform: 'web',
	      currentUrl: 'https://preview.happier.test/app',
	      currentUrlExpiresAt: 1_700_000_000_000,
	      focus: true,
	    }).success).toBe(true);

    expect(mod.BrowserCommandV1Schema.safeParse({
      kind: 'navigate',
      commandId: 'command_2',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://preview.happier.test/app',
    }).success).toBe(true);

    expect(mod.BrowserCommandV1Schema.safeParse({
      kind: 'setAddressInput',
      commandId: 'command_3',
      viewId: 'view_1',
      value: 'https://example.com',
    }).success).toBe(false);
  });

  it('rejects non-http navigation URLs at the control boundary', () => {
    expect(mod.BrowserCommandV1Schema.safeParse({
      kind: 'navigate',
      commandId: 'command_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'javascript:alert(1)',
    }).success).toBe(false);
  });

  it('accepts typed command dispatch results and rejects malformed failures', () => {
    expect(mod.BrowserCommandDispatchResultV1Schema).toBeTypeOf('object');

    expect(mod.BrowserCommandDispatchResultV1Schema.parse({
      v: 1,
      commandId: 'command_1',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    })).toEqual({
      v: 1,
      commandId: 'command_1',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    });

    expect(mod.BrowserCommandDispatchResultV1Schema.parse({
      v: 1,
      commandId: 'command_2',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
      error: {
        code: 'unsupported_command',
        message: 'Command is not supported by this adapter.',
      },
    })).toMatchObject({
      commandId: 'command_2',
      status: 'failed',
      error: { code: 'unsupported_command' },
    });

    expect(mod.BrowserCommandDispatchResultV1Schema.safeParse({
      v: 1,
      commandId: 'command_3',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
      error: {
        code: 'not_a_browser_error',
        message: 'Nope.',
      },
    }).success).toBe(false);

    expect(mod.BrowserCommandDispatchResultV1Schema.safeParse({
      v: 1,
      commandId: 'command_4',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
    }).success).toBe(false);
  });
});

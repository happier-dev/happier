import { describe, expect, it } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
} from '../../engine.testkit.js';
import {
  bindClaudeUnifiedTerminalSession,
  resolveUnifiedTerminalPermissionMode,
} from './bindSession.js';

type InternalHostSessionParamsWithCredentials =
  Parameters<typeof bindClaudeUnifiedTerminalSession>[0]['sessionParams'] & Readonly<{
    credentials: Readonly<{
      token: string;
      encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
    }>;
  }>;

function modeMetadata(modeId: string, updatedAt = 1): Readonly<Record<string, unknown>> {
  return { acpSessionModeOverrideV1: { v: 1, updatedAt, modeId } };
}

describe('bindClaudeUnifiedTerminalSession', () => {
  it('preserves host session credentials on the unified terminal plan opts', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: InternalHostSessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
    };

    const plan = await bindClaudeUnifiedTerminalSession({
      ctx,
      sessionParams,
    });

    expect(plan.opts).toMatchObject({ credentials });
  });
});

describe('resolveUnifiedTerminalPermissionMode', () => {
  it('passes through the raw permission mode when no agent mode is set', () => {
    expect(resolveUnifiedTerminalPermissionMode({ permissionMode: 'safe-yolo' })).toBe('auto');
    expect(resolveUnifiedTerminalPermissionMode({ permissionMode: 'default' })).toBe('default');
  });

  it('returns null when nothing is specified', () => {
    expect(resolveUnifiedTerminalPermissionMode({ permissionMode: null })).toBeNull();
  });

  it('lets the plan agent mode WIN over a safe-yolo permission mode (the dropped-plan bug)', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: 'safe-yolo',
      runtimeMetadata: modeMetadata('plan'),
    })).toBe('plan');
  });

  it('reads the plan agent mode from the initial spawn metadata too', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: null,
      initialMetadata: modeMetadata('plan'),
    })).toBe('plan');
  });

  it('prefers the runtime metadata snapshot over the initial spawn metadata', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: 'default',
      runtimeMetadata: modeMetadata('plan', 20),
      initialMetadata: modeMetadata('build', 5),
    })).toBe('plan');
  });

  it('a non-plan agent mode does not override the raw permission mode', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: 'safe-yolo',
      runtimeMetadata: modeMetadata('build'),
    })).toBe('auto');
  });
});

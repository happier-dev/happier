import { describe, expect, it } from 'vitest';
import { resolveConfiguredWidgetTarget } from './widgetBinding';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const runtime = (serverId: string, machineId: string): PluginUiProjectionCurrentness => ({
  serverId, machineId, phase: 'current', interactionEnabled: true, platform: 'web',
  pluginUiProjection: null, pluginBrowserProjection: null,
});
const session = (id: string, serverId = 'home'): Session => createSessionFixture({ id, serverId });

describe('configured widget executable target', () => {
  it('uses selected B data and runtime when hosted in A or Home, without ambient authority', () => {
    const b = session('B');
    const bRuntime = runtime('home', 'machine-B');
    const result = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'companion', sessionId: 'A' } },
      resolvedInput: { status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } },
      sessionInputPath: 'session', appRuntime: runtime('home', 'machine-A'),
      targetKind: 'session',
      readSession: () => ({ status: 'ready', session: b, runtime: bRuntime }),
    });
    expect(result).toMatchObject({ status: 'ready', target: { kind: 'session', sessionId: 'B', session: b }, runtime: bRuntime });
  });

  it('refuses missing, cross-Home, revoked or mismatched target facts without invoking fallback', () => {
    const base = {
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
      resolvedInput: { status: 'ready' as const, input: { session: { serverId: 'home', sessionId: 'B' } } },
      sessionInputPath: 'session', appRuntime: runtime('home', 'machine-A'),
      targetKind: 'session' as const,
    };
    expect(resolveConfiguredWidgetTarget({ ...base, readSession: () => ({ status: 'denied', reasonCode: 'session_access_denied' }) })).toEqual({ status: 'denied', reasonCode: 'session_access_denied' });
    expect(resolveConfiguredWidgetTarget({ ...base, readSession: () => ({ status: 'ready', session: session('A'), runtime: runtime('home', 'machine-A') }) })).toMatchObject({ status: 'denied' });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: {} }, readSession: () => { throw new Error('must not read without a target'); } })).toMatchObject({ status: 'selection_required' });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: { session: { serverId: 'other-home', sessionId: 'B' } } }, readSession: () => { throw new Error('must not borrow another Home'); } })).toMatchObject({ status: 'denied' });
  });
});

import { describe, expect, it } from 'vitest';
import { resolveConfiguredWidgetTarget } from './widgetBinding';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveConfiguredWidgetInputs, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

const runtime = (serverId: string, machineId: string): PluginUiProjectionCurrentness => ({
  serverId, machineId, phase: 'current', interactionEnabled: true, platform: 'web',
  pluginUiProjection: null, pluginBrowserProjection: null,
});
const session = (id: string, serverId = 'home'): Session => createSessionFixture({ id, serverId });

describe('configured widget executable target', () => {
  it('retains the failed pinned value and field identity as a typed repair outcome', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
      bindings: { repo: { kind: 'value', value: 'removed-repo' } } };
    const descriptor = { inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'select' as const,
      options: [{ value: 'removed-repo', label: 'Old repository' }] }] },
      inputSchema: { type: 'object' as const, properties: { repo: { type: 'string' as const, enum: ['active-repo'] } } } };
    const resolvedInput = resolveConfiguredWidgetInputs({ instance, descriptor, providedContext: {}, viewerValues: {} });
    const result = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, resolvedInput,
      targetKind: 'app', appRuntime: runtime('home', 'machine'), repairContext: { instance, descriptor },
      readSession: () => { throw new Error('an invalid pin must never read a Session'); },
    });
    expect(result).toMatchObject({ status: 'invalid', repair: { kind: 'input',
      field: { path: 'repo', label: 'Repository', selectedLabel: 'Old repository' } } });
  });

  it('preserves denied and missing exact Session facts even when they carry repair fields', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
      bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } };
    const descriptor = { sessionInputPath: 'session', inputs: { fields: [{ path: 'session', title: 'Source session', widget: 'select' as const,
      options: [{ value: { serverId: 'home', sessionId: 'B' }, label: 'Build release' }] }] } };
    for (const status of ['denied', 'unavailable'] as const) {
      const reasonCode = status === 'denied' ? 'widget_session_access_denied' : 'widget_session_unavailable';
      const result = resolveConfiguredWidgetTarget({
        scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'companion', sessionId: 'A' } },
        resolvedInput: { status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } },
        targetKind: 'session', sessionInputPath: 'session', appRuntime: runtime('home', 'machine-A'),
        repairContext: { instance, descriptor },
        readSession: () => ({ status, reasonCode, fields: [{ path: 'session', status, reasonCode }] }),
      });
      expect(result).toMatchObject({ status, repair: { kind: status === 'denied' ? 'session_denied' : 'session_unavailable',
        field: { path: 'session', label: 'Source session', selectedLabel: 'Build release' } } });
    }
    const noLongerInChoices = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
      resolvedInput: { status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } },
      targetKind: 'session', sessionInputPath: 'session', appRuntime: runtime('home', 'machine'),
      repairContext: { instance, descriptor: { ...descriptor, inputs: { fields: [{ ...descriptor.inputs.fields[0]!, options: [] }] } } },
      readSession: () => ({ status: 'unavailable', reasonCode: 'widget_session_unavailable',
        fields: [{ path: 'session', status: 'unavailable', reasonCode: 'widget_session_unavailable' }] }),
    });
    expect(noLongerInChoices).toMatchObject({ repair: { kind: 'session_unavailable', field: { selectedLabel: 'B' } } });
  });

  it('keeps secret values out of the repair outcome, including their option labels', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
      bindings: { token: { kind: 'value', value: 'private-token' } } };
    const descriptor = { inputs: { fields: [{ path: 'token', title: 'Token', widget: 'secret' as const,
      options: [{ value: 'private-token', label: 'private-token' }] }] } };
    const result = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
      resolvedInput: resolveConfiguredWidgetInputs({ instance, descriptor, providedContext: {}, viewerValues: {} }),
      targetKind: 'app', appRuntime: runtime('home', 'machine'), repairContext: { instance, descriptor },
      readSession: () => { throw new Error('secret bindings cannot execute'); },
    });
    expect(result).toMatchObject({ status: 'invalid', repair: { kind: 'input', field: { path: 'token', label: 'Token' } } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
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

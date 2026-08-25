import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { resolveSessionAgentToolPresentation } from './resolveSessionAgentToolPresentation';

describe('resolveSessionAgentToolPresentation', () => {
  it('resolves canonical direct descriptors with session-bound JSON schemas', () => {
    const resolved = resolveSessionAgentToolPresentation({
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
      defaultSessionId: 'sess-1',
      defaultSessionMachineId: 'machine-1',
      requiredDirectActionIds: ['memory.search', 'memory.get_window'],
    });

    expect(resolved.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'change_title',
      'action_spec_search',
      'action_spec_get',
      'action_options_resolve',
      'action_execute',
      'memory_search',
      'memory_get_window',
    ]));

    const search = resolved.find((tool) => tool.name === 'memory_search');
    const window = resolved.find((tool) => tool.name === 'memory_get_window');
    expect(search?.inputSchema.required ?? []).not.toContain('machineId');
    expect(window?.inputSchema.required ?? []).not.toContain('machineId');
    expect(window?.inputSchema.required ?? []).toContain('sessionId');
  });

  it('reflects user-promoted actions without provider-specific policy', () => {
    const resolved = resolveSessionAgentToolPresentation({
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'subagents.delegate.start': { toolExposureModes: { session_agent: 'direct' } },
        },
      }),
      defaultSessionId: 'sess-1',
      defaultSessionMachineId: 'machine-1',
    });

    expect(resolved.map((tool) => tool.name)).toContain('subagents_delegate_start');
  });
});

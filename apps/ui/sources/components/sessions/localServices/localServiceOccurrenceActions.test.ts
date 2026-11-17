import { describe, expect, it } from 'vitest';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { registerSessionTerminalWorkspaceOwner } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { openLocalServiceTerminal } from './localServiceOccurrenceActions';
import { resolveLocalServiceEntryActions } from './localServiceEntryActions';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';

describe('existing service occurrence presentation', () => {
  it('shows stopped retained output through the real terminal Action without any process host port', async () => {
    const scopeId = 'session:address:home:session';
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
    const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state,
      dispatch: action => { state = appPaneReduce(state, action); } });
    // Every process host port fails loudly. Presentation is the real AppPane Action adapter.
    let processEffects = 0;
    const unexpectedProcessEffect = async (): Promise<never> => { processEffects++; throw new Error('Show attempted a process effect'); };
    const execute = createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
      sessionTerminalAction: invokeSessionTerminalAction,
      machineTerminalAction: unexpectedProcessEffect,
      runtimeActionExecute: unexpectedProcessEffect,
    }), 'account'));
    const target = LocalServiceLaunchTargetV1Schema.parse({ id: 'declaration', source: 'managed_service', machineId: 'machine',
      title: 'web', confidence: 'high', state: 'unavailable', serviceState: 'stopped', unavailableReason: 'launch_unavailable', actions: [],
      sourceClass: { kind: 'managed_service', managedServiceId: 'occurrence' },
      terminalView: { kind: 'terminal_view', machineId: 'machine', terminalKey: 'declaration', terminalId: 'retained', cwd: '/repo' } });
    const row = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' })[0];
    const offers = resolveLocalServiceEntryActions(row, { onShowServiceTerminal: async () => {}, onShowServiceLogs: async () => {} });
    expect(offers.showTerminal).toEqual(target);
    expect(offers.showLogs).toEqual({ machineId: 'machine', serviceId: 'declaration', expectedGeneration: 'occurrence', name: 'web' });
    try {
      const open = () => openLocalServiceTerminal(target, (actionId, input) => execute(actionId, { ...input, scopeId },
        { surface: 'ui', authority: 'present_user', serverId: 'home' }));
      expect(await open()).toMatchObject({ ok: true });
      expect(await open()).toMatchObject({ ok: true });
      const listed = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
      expect(listed).toMatchObject({ ok: true });
      if (!('workspace' in listed) || !listed.workspace) throw new Error('Missing presentation');
      const attached = listed.workspace.tabs.flatMap(tab => tab.terminals).filter(member => member.target.kind === 'terminal_view');
      expect(attached).toHaveLength(1);
      expect(attached[0].target).toEqual(target.terminalView);
      expect(processEffects).toBe(0);
    } finally { retire(); }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appPaneReduce,
  createAppPaneState,
} from '@/components/appShell/panes/model/appPaneReducer';
import { invokeSessionTerminalAction } from './sessionTerminalActions';
import { registerSessionTerminalWorkspaceOwner } from './sessionTerminalWorkspaceRuntime';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { storage } from '@/sync/domains/state/storage';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { buildProjectTerminalKey } from '@/components/projects/detail/projectTerminalScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createPlainMachineRowFixture } from '@/dev/testkit';

// Machine transport and the person's dialog are the boundaries; the Action executor and its approval policy stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: machineRpc }),
);
const modal = vi.hoisted(() => ({ answer: true }));
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: { confirm: async () => modal.answer },
    }).module,
);

afterEach(() => {
  machineRpc.mockReset();
});

describe('closing several Project Shells', () => {
  it.each([true, false])(
    'asks once, naming the count, before stopping them (confirmed: %s)',
    async (answer) => {
      modal.answer = answer;
      const { Modal } = await import('@/modal');
      const confirm = vi.mocked(Modal.confirm);
      confirm.mockClear();
      const serverId = `srv_close_many_${answer}`;
      const checkout = {
        id: 'accepted',
        serverId,
        machineId: 'machine',
        rootPath: '/accepted',
        projectKey: 'project',
        createdAtMs: 1,
      };
      // No waiver: a Project Shell's close is a Machine terminal Action the UI confirms by default.
      const home = await serveActionHomes({
        homes: [
          {
            key: 'project',
            serverUrl: `https://close-many-${answer}.test`,
            accountId: 'bob',
            serverIdentityId: serverId,
          },
        ],
        route: (request) =>
          request.path === '/v1/machines'
            ? Response.json([
                createPlainMachineRowFixture({
                  id: 'machine',
                  accountId: 'bob',
                }),
              ])
            : request.path === '/v1/account/project-rows/list'
              ? Response.json(
                  createPlainProjectAccountRowListFixture({
                    workspaceRefs: [checkout],
                  }),
                )
              : undefined,
      });
      publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
      const scopeId = buildProjectPaneScopeId(
        checkout.id,
        serverId,
        'destination',
      );
      const workspace = {
        serverId,
        workspaceId: checkout.id,
        machineId: checkout.machineId,
        rootPath: checkout.rootPath,
      };
      let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), {
        type: 'activateScope',
        scopeId,
      });
      const retire = registerSessionTerminalWorkspaceOwner({
        getState: () => state,
        dispatch: (action) => {
          state = appPaneReduce(state, action);
        },
      });
      try {
        await expect
          .poll(() => readCurrentProjectAccountRows(storage.getState()))
          .toMatchObject({ status: 'ready' });
        const ids: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          const opened = await invokeSessionTerminalAction({
            actionId: 'session.terminals.open',
            input: { scopeId, target: { kind: 'workspace_shell', workspace } },
          });
          if (!('terminalId' in opened) || !opened.terminalId)
            throw new Error('Project shell did not open');
          ids.push(opened.terminalId);
        }
        const processes = ids.map((id, index) => ({
          terminalId: `pty-${index}`,
          terminalKey: buildProjectTerminalKey(
            { serverId, accountId: 'bob' },
            workspace,
            id,
          ),
          cwd: workspace.rootPath,
          ended: false,
          exit: null,
        }));
        const running = new Set(processes.map((process) => process.terminalId));
        machineRpc.mockImplementation(
          async (request: {
            method: string;
            payload: { terminalId?: string };
          }) => {
            if (request.method === 'daemon.terminal.list')
              return {
                ok: true,
                terminals: processes.filter((process) =>
                  running.has(process.terminalId),
                ),
              };
            if (request.payload.terminalId)
              running.delete(request.payload.terminalId);
            return { ok: true };
          },
        );
        const result = await invokeSessionTerminalAction({
          actionId: 'session.terminals.close_others',
          input: { scopeId, tabId: ids[0]! },
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(String(confirm.mock.calls[0]![0])).toContain('3');
        if (answer) {
          expect(result).toEqual({ ok: true });
          expect([...running]).toEqual(['pty-0']);
        } else {
          expect(result).toMatchObject({
            ok: false,
            errorCode: 'approval_canceled',
          });
          expect(running.size).toBe(4);
          const listed = await invokeSessionTerminalAction({
            actionId: 'session.terminals.list',
            input: { scopeId },
          });
          expect(listed).toMatchObject({
            ok: true,
            workspace: { tabs: ids.map(() => expect.anything()) },
          });
        }
      } finally {
        retire();
        await home.dispose();
      }
    },
  );

    it('asks once before stopping one Project Shell, naming that Shell', async () => {
        modal.answer = true;
        const { Modal } = await import('@/modal');
        const confirm = vi.mocked(Modal.confirm);
        confirm.mockClear();
        const serverId = 'srv_close_one';
        const checkout = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', projectKey: 'project', createdAtMs: 1 };
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://close-one.test', accountId: 'bob', serverIdentityId: serverId }],
            route: request => request.path === '/v1/machines'
                ? Response.json([createPlainMachineRowFixture({ id: 'machine', accountId: 'bob' })])
                : request.path === '/v1/account/project-rows/list'
                    ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [checkout] })) : undefined });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scopeId = buildProjectPaneScopeId(checkout.id, serverId, 'destination');
        const workspace = { serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath };
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: action => { state = appPaneReduce(state, action); } });
        try {
            await expect.poll(() => readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready' });
            const opened = await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId, target: { kind: 'workspace_shell', workspace } } });
            if (!('terminalId' in opened) || !opened.terminalId) throw new Error('Project shell did not open');
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.rename', input: { scopeId, terminalId: opened.terminalId, title: 'api server' } }))
                .toMatchObject({ ok: true });
            const terminalKey = buildProjectTerminalKey({ serverId, accountId: 'bob' }, workspace, opened.terminalId);
            let running = true;
            machineRpc.mockImplementation(async (request: { method: string }) => {
                if (request.method === 'daemon.terminal.list') return { ok: true, terminals: running ? [{ terminalId: 'pty', terminalKey, cwd: workspace.rootPath, ended: false, exit: null }] : [] };
                running = false;
                return { ok: true };
            });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId: opened.terminalId } })).toEqual({ ok: true });
            expect(running).toBe(false);
            expect(confirm).toHaveBeenCalledOnce();
            expect(String(confirm.mock.calls[0]![0])).toContain('api server');
            expect(String(confirm.mock.calls[0]![0])).not.toContain('machine');
        } finally { retire(); await home.dispose(); }
    });
});

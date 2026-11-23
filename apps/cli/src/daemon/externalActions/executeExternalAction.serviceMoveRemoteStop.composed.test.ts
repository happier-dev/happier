import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { logger } from '@/ui/logger';

import {
  createHarness,
  resetFilesystemApprovalSocketBoundary,
} from './executeExternalAction.filesystemApprovals.testkit';

beforeEach(() => resetServerFeaturesClientForTests());
afterEach(() => {
  vi.restoreAllMocks();
  resetFilesystemApprovalSocketBoundary();
  withdrawActiveProjectAccountRowsSnapshot();
});

// A person's Move whose Service runs on a worker: SOURCE's child Stop crosses the
// real exact Machine RPC (its exact-target check included) to the worker's daemon.
describe('person service Move with a worker incumbent', () => {
  it.each(['default', 'ui_person'] as const)(
    'derives the worker incumbent Stop from the signed Move through the real exact-target check (%s)',
    async (originalCli) => {
      const h = await createHarness(
        'projects.service.relocate',
        'allowed',
        false,
        'srv_portableHome',
        undefined,
        true,
        false,
        {
          authentication: originalCli === 'ui_person' ? 'account' : 'terminal',
        },
      );
      const service = await h.seedMoveService(null, 'web', 'stopped', true);
      const refusals = vi.spyOn(logger, 'debug');
      try {
        expect(await h.ensureWorkerLink()).toMatchObject({ state: 'watching' });
        service.finishStop();
        const terminal = ActionOperationGetV1ResponseSchema.parse(
          await h.prepareSignedMove({
            sourceCoordinator: true,
            executeMove: service.request,
            originalCli,
            ...(originalCli === 'default' ? { approveRequiredChild: true as const } : {}),
          }),
        );
        const targetRefusals = refusals.mock.calls.filter(
          ([message]) => message === '[MachineRPC] exact target refused',
        );
        expect(targetRefusals, JSON.stringify(targetRefusals)).toEqual([]);
        expect(service.stopCalls()).toBe(1);
        expect(service.snapshot().state).toBe('stopped');
        // The real Stop passed and the Move went on to its destination Start. That
        // Start runs on SOURCE, whose launcher this harness does not install, so the
        // destination step itself is not proven here.
        expect(terminal, JSON.stringify(terminal)).toMatchObject({ kind: 'found', operation: {
          progress: { phase: 'starting' } } });
      } finally {
        service.finishStop();
        await Promise.all(
          h
            .serviceInstances()
            .filter(
              (instance) => instance.workspace.rootPath === h.ref.rootPath,
            )
            .map((instance) => instance.stop()),
        );
        await h.close();
      }
    },
  );
  // Pins today's external MCP Move: an agent acting for the person reaches SOURCE
  // through its own MCP route, and the Account policy (MCP not waived) asks the
  // person before anything runs. The derivation fix must not change this.
  it('asks the person before an external MCP Move of a SOURCE Service runs', async () => {
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true, false,
      { authentication: 'terminal' });
    const service = await h.seedMoveService();
    try {
      expect(await h.ensureWorkerLink()).toMatchObject({ state: 'watching' });
      expect(await h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request, originalCli: 'mcp', proposalOnly: true }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.service.relocate' } });
      expect(service.stopCalls()).toBe(0);
      expect(service.snapshot().state).toBe('running');
      expect(h.copies()).toBe(0);
    } finally {
      service.finishStop();
      await h.close();
    }
  });
});

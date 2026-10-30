import { afterEach, expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { act, renderHook, standardCleanup } from '@/dev/testkit';

import { useFoundMachineScans, type FoundMachineScanOutcome } from './useFoundMachineScans';

afterEach(() => {
  standardCleanup();
});

/** The scan is the shared part both Found pages sit on; the machine read itself is the caller's `scanOne`. */
async function scanOnce(scanOne: () => Promise<FoundMachineScanOutcome>) {
  const hook = await renderHook(() => useFoundMachineScans('skill', ['m1'], scanOne));
  try {
    await act(async () => { await hook.getCurrent().scan('m1'); });
    return hook.getCurrent().scans[0]!;
  } finally {
    await hook.unmount();
  }
}

it('keeps the typed cause of a thrown RPC failure, the same code the Action refusal path carries', async () => {
  const unavailable = await scanOnce(async () => { throw Object.assign(new Error('transport down'), { rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }); });
  expect(unavailable).toMatchObject({ failure: 'failed', cause: 'RPC_TRANSPORT_UNAVAILABLE' });
  // A lost answer is uncertain, whatever other typed code the transport also carried.
  const lost = await scanOnce(async () => {
    throw markRpcRequestDisposition(Object.assign(new Error('answer lost'), { rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }), 'outcomeUnknown');
  });
  expect(lost).toMatchObject({ failure: 'failed', cause: 'RPC_OUTCOME_UNKNOWN' });
});

it('leaves a refusal outcome as the caller reported it, and an untyped throw without a cause', async () => {
  expect(await scanOnce(async () => ({ failure: 'failed', cause: 'machine_unreachable' }))).toMatchObject({ failure: 'failed', cause: 'machine_unreachable' });
  expect(await scanOnce(async () => { throw new Error('boom'); })).toMatchObject({ failure: 'failed', cause: null });
  expect(await scanOnce(async () => null)).toMatchObject({ failure: null, cause: null });
});

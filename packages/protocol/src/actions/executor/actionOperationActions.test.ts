import { describe, expect, it, vi } from 'vitest';
import { executeActionOperationActionV1, type ActionOperationMachineTransportV1 } from './actionOperationActions.js';
import type { ActionOperationSnapshotV1 } from '../operations/v1.js';

const address = { serverId: 'custody-home', machineId: 'custodian', operationId: 'command' };
const command: ActionOperationSnapshotV1 = {
  version: 1, operationId: 'command', revision: 3, actionId: 'projects.script.run', state: 'failed',
  scope: { accountId: 'account', machineId: 'custodian' }, title: 'Build', createdAt: 1, startedAt: 2, settledAt: 3,
  cancellation: 'supported', error: { errorCode: 'process_exited', error: 'Exit 1' },
  domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'execution-home', machineId: 'worker',
    workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' },
};
const output = {
  ok: true as const, terminalId: 'terminal', frames: [
    { t: 'gap' as const, terminalId: 'terminal', droppedBeforeByteOffset: 4, nextAvailableByteOffset: 4, reason: 'ring_overflow' as const },
    { t: 'bytes' as const, terminalId: 'terminal', seq: 1, byteOffset: 4, byteLength: 3, encoding: 'base64' as const, data: 'YWJj' },
  ], nextByteOffset: 7, availableByteOffset: 7, droppedBeforeByteOffset: 4, done: true,
};

describe('operation attachment output adapter', () => {
  it('reads retained failed output from the witnessed target using the existing ring cursor and gap', async () => {
    const { domainRef: _attachment, ...predecessorCommand } = command;
    // The network exposes both epochs: the predecessor response cannot carry
    // a Project attachment. Only the current reader can reach its byte ring.
    const transport = vi.fn(async (request: Parameters<ActionOperationMachineTransportV1>[0]) => {
      if (request.method === 'actionOperation.get.v1') return { kind: 'found', operation: predecessorCommand };
      if (request.method === 'actionOperation.get.v2') return { kind: 'found', operation: command };
      if (request.method === 'daemon.terminal.stream.readBytes') return output;
      throw new Error('Unexpected operation transport request');
    });
    const signal = new AbortController().signal;
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
      input: { ...address, byteOffset: 0, maxBytes: 8 }, signal, transport })).toEqual(output);
    expect(transport.mock.calls.map(([request]) => request)).toEqual([
      { serverId: 'custody-home', machineId: 'custodian', method: 'actionOperation.get.v2', payload: { operationId: 'command' }, signal },
      { serverId: 'execution-home', machineId: 'worker', method: 'daemon.terminal.stream.readBytes', payload: { terminalId: 'terminal', byteOffset: 0, maxBytes: 8 }, signal },
    ]);
  });

  it('never reads bytes without a currently authorized matching operation attachment', async () => {
    for (const reply of [
      { kind: 'not_found' },
      { kind: 'found', operation: { ...command, operationId: 'another' } },
      { kind: 'found', operation: { ...command, domainRef: undefined } },
      { kind: 'found', operation: { ...command, domainRef: { ...command.domainRef, terminalId: undefined } } },
    ]) {
      const transport = vi.fn().mockResolvedValue(reply);
      expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
        input: { ...address, byteOffset: 0 }, transport })).toMatchObject({ ok: false });
      expect(transport.mock.calls.map(([request]) => request.method)).toEqual(['actionOperation.get.v2']);
    }
  });

  it('returns structured bytes in headless copy and propagates denied target reads', async () => {
    const transport = vi.fn().mockResolvedValueOnce({ kind: 'found', operation: command }).mockResolvedValueOnce(output);
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy',
      input: { ...address, byteOffset: 0 }, transport })).toEqual({ kind: 'bytes', output });
    transport.mockReset().mockResolvedValueOnce({ kind: 'found', operation: command })
      .mockResolvedValueOnce({ ok: false, code: 'permission_denied', message: 'Grant revoked' });
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
      input: { ...address, byteOffset: 7 }, transport })).toEqual({ ok: false, errorCode: 'permission_denied', error: 'Grant revoked' });
    transport.mockReset().mockResolvedValueOnce({ ok: false, errorCode: 'permission_denied', error: 'Operation grant revoked' });
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
      input: { ...address, byteOffset: 7 }, transport })).toEqual({ ok: false, errorCode: 'permission_denied', error: 'Operation grant revoked' });
  });
});

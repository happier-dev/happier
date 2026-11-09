import { describe, expect, it, vi } from 'vitest';
import { executeActionOperationActionV1, type ActionOperationMachineTransportV1 } from './actionOperationActions.js';
import { ActionOperationGetV2RequestSchema, type ActionOperationSnapshotV1 } from '../operations/v1.js';
import { ActionOperationActionInputSchemasV1, ProjectExecutionOutputCopyResultV1Schema } from '../specs/actionOperations.js';

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
  it('reads a failed operation and its output when the worker adds an unfamiliar cause', async () => {
    const transport: ActionOperationMachineTransportV1 = async ({ method }) => method === 'actionOperation.get.v2'
      ? { kind: 'found', operation: { ...command, error: { ...command.error,
        cause: { privateDiagnostic: 'must-not-cross-the-reader' } } } } : output;
    const read = await executeActionOperationActionV1({ actionId: 'action.operations.get', input: address, transport });
    expect(read).toMatchObject({ operation: { state: 'failed', error: {
      errorCode: 'process_exited', failureCause: { kind: 'unknown', errorCode: 'unknown_failure_cause' },
    } } });
    expect(JSON.stringify(read)).not.toContain('must-not-cross-the-reader');
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
      input: { ...address, byteOffset: 4 }, transport })).toEqual(output);
  });

  it('keeps operation Environment routing in the signed Action instead of widening the RPC input', async () => {
    const input = ActionOperationActionInputSchemasV1['action.operations.get'].parse({
      ...address, environmentId: 'selected-environment', waitForTerminal: true,
    });
    const transport: ActionOperationMachineTransportV1 = async request => {
      expect(ActionOperationGetV2RequestSchema.parse(request.payload)).toEqual({ operationId: address.operationId, waitForTerminal: true });
      return { kind: 'found', operation: command };
    };
    expect(await executeActionOperationActionV1({ actionId: 'action.operations.get', input, transport }))
      .toMatchObject({ kind: 'found', operation: { operationId: address.operationId } });
  });
  it('copies exactly the selected byte interval and returns the same receipt for UI and headless callers', async () => {
    const request = { ...address, byteOffset: 4, selection: { kind: 'bytes', endByteOffset: 6 } };
    const transport = vi.fn(async ({ method }: Parameters<ActionOperationMachineTransportV1>[0]) =>
      method === 'actionOperation.get.v2' ? { kind: 'found', operation: command } : output);
    const input = ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse(request);
    const headless = await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport });
    const copied: unknown[] = [];
    const ui = await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport,
      copyOutput: async selected => { copied.push(selected); } });
    const receipt = { request, text: 'ab', coverage: { complete: true, gaps: [] } };
    expect(headless).toMatchObject({ kind: 'bytes', selection: receipt });
    expect(ui).toMatchObject({ kind: 'copied', selection: receipt });
    expect(ProjectExecutionOutputCopyResultV1Schema.parse(headless)).toEqual(headless);
    expect(copied).toMatchObject([{ frames: [{ t: 'bytes', byteOffset: 4, byteLength: 2, data: 'YWI=' }], nextByteOffset: 6 }]);
    expect(transport.mock.calls.filter(([request]) => request.method === 'daemon.terminal.stream.readBytes')
      .map(([request]) => request.payload)).toEqual([
        { terminalId: 'terminal', byteOffset: 4, maxBytes: 2 },
        { terminalId: 'terminal', byteOffset: 4, maxBytes: 2 },
      ]);
  });

  it('reports evicted selected bytes and never substitutes other output for them', async () => {
    const request = { ...address, byteOffset: 1, selection: { kind: 'bytes', endByteOffset: 6 } };
    const input = ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse(request);
    const transport = vi.fn(async ({ method }: Parameters<ActionOperationMachineTransportV1>[0]) =>
      method === 'actionOperation.get.v2' ? { kind: 'found', operation: command } : output);
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport }))
      .toMatchObject({ kind: 'bytes', selection: { request, text: 'ab', coverage: { complete: false,
        gaps: [{ startByteOffset: 1, endByteOffset: 4, reason: 'evicted' }] } } });
  });

  it('typed-refuses rendered terminal rows without a proven raw-byte mapping before any read or copy', async () => {
    const input = ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse({ ...address, byteOffset: 0,
      selection: { kind: 'rendered', startLine: 1, endLine: 2, text: 'selected terminal text' } });
    const transport = vi.fn();
    const copyOutput = vi.fn();
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport, copyOutput }))
      .toMatchObject({ ok: false, errorCode: 'operation_output_selection_mapping_unavailable' });
    expect(transport).not.toHaveBeenCalled();
    expect(copyOutput).not.toHaveBeenCalled();
  });

  it('reports an undelivered tail without reading beyond the caller budget', async () => {
    const request = { ...address, byteOffset: 4, maxBytes: 3, selection: { kind: 'bytes', endByteOffset: 9 } };
    const input = ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse(request);
    const transport = vi.fn(async ({ method }: Parameters<ActionOperationMachineTransportV1>[0]) =>
      method === 'actionOperation.get.v2' ? { kind: 'found', operation: command } : output);
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport }))
      .toMatchObject({ kind: 'bytes', selection: { request, text: 'abc', coverage: { complete: false,
        gaps: [{ startByteOffset: 7, endByteOffset: 9, reason: 'not_returned' }] } } });
    expect(transport.mock.calls.filter(([request]) => request.method === 'daemon.terminal.stream.readBytes')
      .map(([request]) => request.payload)).toEqual([{ terminalId: 'terminal', byteOffset: 4, maxBytes: 3 }]);
  });

  it('never copies retained bytes outside an entirely evicted selection', async () => {
    const request = { ...address, byteOffset: 0, selection: { kind: 'bytes', endByteOffset: 2 } };
    const input = ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse(request);
    const transport = vi.fn(async ({ method }: Parameters<ActionOperationMachineTransportV1>[0]) =>
      method === 'actionOperation.get.v2' ? { kind: 'found', operation: command } : output);
    const copied: unknown[] = [];
    const result = await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport,
      copyOutput: async selected => { copied.push(selected); } });
    expect(ProjectExecutionOutputCopyResultV1Schema.parse(result)).toMatchObject({ kind: 'copied',
      output: { frames: [] }, selection: { request, text: '', coverage: { complete: false,
        gaps: [{ startByteOffset: 0, endByteOffset: 2, reason: 'evicted' }] } } });
    expect(copied).toMatchObject([{ frames: [] }]);
  });

  it('decodes selected UTF-8 across real byte-frame boundaries and preserves clipboard refusal', async () => {
    const input = ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse({ ...address,
      byteOffset: 4, selection: { kind: 'bytes', endByteOffset: 7 } });
    const transport: ActionOperationMachineTransportV1 = async ({ method }) => method === 'actionOperation.get.v2'
      ? { kind: 'found', operation: command } : { ...output, frames: [
        { t: 'bytes', terminalId: 'terminal', seq: 1, byteOffset: 4, byteLength: 1, encoding: 'base64', data: '4g==' },
        { t: 'bytes', terminalId: 'terminal', seq: 2, byteOffset: 5, byteLength: 2, encoding: 'base64', data: 'gqw=' },
      ] };
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport }))
      .toMatchObject({ selection: { text: '€', coverage: { complete: true, gaps: [] } } });
    expect(await executeActionOperationActionV1({ actionId: 'projects.execution.output.copy', input, transport,
      copyOutput: async () => ({ ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' }) }))
      .toEqual({ ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' });
  });

  it('rejects unknown or invalid selection operands through the canonical copy schema', () => {
    const schema = ActionOperationActionInputSchemasV1['projects.execution.output.copy'];
    for (const selection of [
      { kind: 'bytes', endByteOffset: 4 },
      { kind: 'bytes', endByteOffset: 6, terminalId: 'other' },
      { kind: 'lines', startLine: 0, endLine: 2 },
    ]) expect(schema.safeParse({ ...address, byteOffset: 4, selection }).success).toBe(false);
  });

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

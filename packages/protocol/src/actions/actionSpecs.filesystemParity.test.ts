import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

const mutations = [
  { id: 'daemon.filesystem.createDirectory', input: { rootPath: '/workspace', path: 'folder' }, method: 'createDirectory' },
  { id: 'daemon.filesystem.rename', input: { rootPath: '/workspace', from: 'a', to: 'b', overwrite: false }, method: 'renamePath' },
  { id: 'daemon.filesystem.delete', input: { rootPath: '/workspace', path: 'folder', recursive: false }, method: 'deletePath' },
  { id: 'daemon.filesystem.copy', input: { rootPath: '/workspace', from: 'a', to: 'b', overwrite: false, recursive: false }, method: 'copyPath' },
] as const;

describe('filesystem Action parity', () => {
  it('exposes qualified strict filesystem mutations through the machine owner with Ask first', () => {
    for (const { id, input, method } of mutations) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, unrelatedAuthority: 'allow' }).success).toBe(false);
      const { rootPath: _root, ...unqualified } = input;
      expect(spec.inputSchema.safeParse(unqualified).success).toBe(false);
      expect(spec.bindings?.rpcMethod).toBe(id);
      expect(spec.bindings?.rpcMethodAliases).toContain(method);
      expect(spec.bindings?.mcpToolName).toBeTruthy();
      expect(spec.bindings?.voiceClientToolName).toBeTruthy();
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true });
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
      expect(spec.outputSchema.safeParse({ success: false, error: 'Destination already exists' }).success).toBe(true);
      expect(spec.outputSchema.safeParse({ success: true, invented: true }).success).toBe(false);
    }
  });

  it('requires an explicit choice for overwrite and recursive effects', () => {
    for (const { id, input } of mutations.slice(1)) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      const record: Record<string, unknown> = { ...input };
      delete record.overwrite;
      delete record.recursive;
      expect(spec.inputSchema.safeParse(record).success).toBe(false);
    }
  });

  it('admits qualified cross-target byte custody without treating source identity as an OS path', () => {
    const spec = getActionSpec('daemon.filesystem.copy');
    const input = { kind: 'prepared_transfer', source: { kind: 'file', serverId: 'source-home', machineId: 'source-machine',
      rootPath: '/source', path: 'literal\nname ', sourceId: 'admitted-source', sizeBytes: 4, sha256: 'a'.repeat(64) },
      destination: { serverId: 'destination-home', machineId: 'destination-machine', rootPath: '/destination', path: 'copy' },
      overwrite: false, recursive: false };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    const targetCopy = { ...input, kind: 'target_copy', source: { serverId: 'source-home', machineId: 'source-machine',
      rootPath: '/source', path: 'literal\nname ' } };
    expect(spec.inputSchema.parse(targetCopy)).toEqual(targetCopy);
    expect(spec.inputSchema.safeParse({ ...targetCopy, source: { ...targetCopy.source, sourceId: '/privileged' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, localSourcePath: '/privileged' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, destination: { ...input.destination, requesterAccountId: 'invented' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, source: { ...input.source, kind: 'directory' } }).success).toBe(false);
    const entryTree = { operationId: 'entry-operation', expectation: { kind: 'directory', fingerprint: 'b'.repeat(64) },
      blobs: [{ transferId: 'entry-operation:blob', sizeBytes: 4, manifestHash: `sha256:${'c'.repeat(64)}` }] };
    expect(spec.inputSchema.parse({ ...input, recursive: true, source: { ...input.source, kind: 'entry_tree', entryTree } }))
      .toMatchObject({ source: { kind: 'entry_tree', entryTree } });
    expect(spec.inputSchema.safeParse({ ...input, source: { ...input.source, kind: 'entry_tree', entryTree: { ...entryTree, rootPath: '/invented' } } }).success).toBe(false);
    expect(spec.operation).toMatchObject({ version: 1, visibility: 'activity' });
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
      context: { surface: 'cli', authority: 'account_automation' } }))
      .toMatchObject({ required: true, flow: 'blocking', result: 'required' });
  });

  it('declares full prepared transfers as tracked machine operations with strict source and destination identity', () => {
    const transfers = [
      { id: 'daemon.filesystem.upload', input: { rootPath: '/workspace', path: 'binary', source: { sourceId: 'source', sizeBytes: 4 }, overwrite: false } },
      { id: 'daemon.filesystem.download', input: { rootPath: '/workspace', path: 'binary', destination: { destinationId: 'destination' }, asZip: false } },
    ] as const;
    for (const { id, input } of transfers) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, requesterAccountId: 'untrusted' }).success).toBe(false);
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.operation).toMatchObject({ version: 1, visibility: 'activity' });
      // Admission cannot hand custody to durable replay: the invoking byte
      // driver must remain mounted until the approval decision arrives.
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
        context: { surface: 'cli', authority: 'account_automation' } }))
        .toMatchObject({ required: true, flow: 'blocking', result: 'required' });
      expect(spec.outputSchema.safeParse({ success: true }).success).toBe(false);
    }
    const cancel = getActionSpec(ActionIdSchema.parse('daemon.filesystem.transfer.cancel'));
    expect(cancel.bindings?.mcpToolName).toBeTruthy();
    expect(cancel.bindings?.voiceClientToolName).toBeTruthy();
    expect(cancel.inputSchema.parse({ rootPath: '/workspace', direction: 'upload', transferId: 'transfer' })).toEqual({ rootPath: '/workspace', direction: 'upload', transferId: 'transfer' });
    expect(cancel.inputSchema.safeParse({ direction: 'upload', transferId: 'transfer' }).success).toBe(false);
    expect(getActionSpec('daemon.filesystem.download').inputSchema.safeParse({ rootPath: '/workspace', path: 'file',
      destination: { destinationId: 'destination' }, asZip: false, confinedToWorkingDirectory: false }).success).toBe(false);
    expect(getActionSpec('daemon.filesystem.download').inputSchema.parse({ rootPath: '/workspace', path: 'directory',
      destination: { destinationId: 'destination' }, asZip: false, format: 'entry_tree' }))
      .toMatchObject({ format: 'entry_tree' });
    expect(getActionSpec('daemon.filesystem.download').inputSchema.safeParse({ rootPath: '/workspace', path: 'directory',
      destination: { destinationId: 'destination' }, asZip: true, format: 'entry_tree' }).success).toBe(false);
  });
});

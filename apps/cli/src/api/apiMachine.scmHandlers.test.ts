import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';

const tempDirectories: string[] = [];

function createMachine(): Machine {
  return {
    id: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

afterEach(() => {
  delete process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('ApiMachineClient SCM handlers', () => {
  it('registers SCM RPCs as machine-scoped handlers', () => {
    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as { rpcHandlerManager: {
      hasHandler: (method: string) => boolean;
    } }).rpcHandlerManager;

    expect(rpc.hasHandler(RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_DIFF_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_DIFF_COMMIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_LOG_LIST)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_PULL_REQUEST_LIST)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_PULL_REQUEST_GET)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK)).toBe(true);
  });

  it('applies configured restricted roots to machine-scoped SCM cwd validation', async () => {
    const suiteDir = mkdtempSync(join(tmpdir(), 'happier-api-machine-scm-'));
    tempDirectories.push(suiteDir);
    const allowedRoot = join(suiteDir, 'allowed');
    const outsideRoot = join(suiteDir, 'outside');
    process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = allowedRoot;

    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as { rpcHandlerManager: {
      invokeLocal: (method: string, params: unknown) => Promise<unknown>;
    } }).rpcHandlerManager;

    const response = await rpc.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: outsideRoot });

    expect(response).toMatchObject({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
    });
  });
});

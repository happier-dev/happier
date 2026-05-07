import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import {
  buildConnectedServiceCredentialRecord,
  SCM_OPERATION_ERROR_CODES,
  type ScmPullRequestOpenOrReuseRequest,
  type ScmPullRequestOpenOrReuseResponse,
} from '@happier-dev/protocol';
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
  vi.unstubAllGlobals();
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('ApiMachineClient SCM handlers', () => {
  it('passes connected account credentials to machine-scoped SCM pull request handlers', async () => {
    const suiteDir = mkdtempSync(join(tmpdir(), 'happier-api-machine-scm-pr-'));
    tempDirectories.push(suiteDir);
    const workspace = join(suiteDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workspace, stdio: 'ignore' });
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: workspace, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: workspace, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', 'feature/machine-connected-rest'], { cwd: workspace, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git'], { cwd: workspace, stdio: 'ignore' });
    process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = workspace;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [],
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({
          number: 53,
          title: 'Machine connected PR',
          html_url: 'https://github.com/happier-dev/happier/pull/53',
          state: 'open',
          base: { ref: 'main' },
          head: { ref: 'feature/machine-connected-rest' },
          merged_at: null,
        }),
        text: async (): Promise<string> => '',
      };
    });
    vi.stubGlobal('fetch', fetcher);
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_machine',
        providerAccountId: '42',
        providerEmail: null,
      },
    });
    type ApiMachineClientConstructorWithDeps = new (
      token: string,
      machine: Machine,
      ownershipMetadata: undefined,
      deps: Readonly<{
        connectedAccounts: {
          resolveCredential(serviceId: 'github'): Promise<typeof record | null>;
        };
      }>,
    ) => ApiMachineClient;
    const ClientWithDeps = ApiMachineClient as unknown as ApiMachineClientConstructorWithDeps;
    const client = new ClientWithDeps('token', createMachine(), undefined, {
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    });
    const rpc = (client as unknown as { rpcHandlerManager: {
      invokeLocal: (method: string, params: unknown) => Promise<unknown>;
    } }).rpcHandlerManager;

    const response = await rpc.invokeLocal(
      RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
      {
        cwd: '.',
        base: 'main',
        head: 'feature/machine-connected-rest',
        title: 'Machine connected PR',
        body: 'Uses machine-scoped connected credentials.',
      } satisfies ScmPullRequestOpenOrReuseRequest,
    ) as ScmPullRequestOpenOrReuseResponse;

    expect(response).toMatchObject({
      success: true,
      kind: 'opened',
      pullRequest: {
        number: 53,
        title: 'Machine connected PR',
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/repos/happier-dev/happier/pulls'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_machine',
        }),
      }),
    );
  });

  it('registers SCM RPCs as machine-scoped handlers', () => {
    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as { rpcHandlerManager: {
      hasHandler: (method: string) => boolean;
    } }).rpcHandlerManager;

    expect(rpc.hasHandler(RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_DIFF_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_DIFF_COMMIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_LOG_LIST)).toBe(true);
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

  it('uses the configured restricted root when machine-scoped SCM cwd is omitted', async () => {
    const suiteDir = mkdtempSync(join(tmpdir(), 'happier-api-machine-scm-default-'));
    tempDirectories.push(suiteDir);
    const allowedRoot = join(suiteDir, 'allowed');
    mkdirSync(allowedRoot, { recursive: true });
    process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = allowedRoot;

    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as unknown as { rpcHandlerManager: {
      invokeLocal: (method: string, params: unknown) => Promise<unknown>;
    } }).rpcHandlerManager;

    const response = await rpc.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, {});

    expect(response).toMatchObject({
      success: true,
      snapshot: expect.objectContaining({
        repo: expect.objectContaining({
          isRepo: false,
        }),
      }),
    });
  });
});

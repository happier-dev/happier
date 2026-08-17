import { describe, expect, it, vi } from 'vitest';

import type {
  ExecService,
  PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';

import { createOpenCodeHandoffSurfaceForExec } from './descriptor.js';

function encodeExportPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function buildVendorExport(params?: Readonly<{
  sessionId?: string;
  projectID?: string;
  partText?: string;
}>): Readonly<Record<string, unknown>> {
  const sessionId = params?.sessionId ?? 'oc-import-1';
  return {
    info: {
      id: sessionId,
      projectID: params?.projectID ?? 'source-project',
      title: 'Imported session',
    },
    messages: [{
      info: {
        id: 'message-1',
        sessionID: sessionId,
        role: 'user',
      },
      parts: [{
        id: 'part-1',
        messageID: 'message-1',
        sessionID: sessionId,
        type: 'text',
        text: params?.partText ?? 'hello',
      }],
    }],
  };
}

function createExecFixture(
  run: ExecService['run'],
): ExecService {
  return {
    agentCli: {
      async checkReadiness() {
        return { launchable: [] };
      },
    },
    systemTools: {
      async resolve() {
        return {
          executable: { kind: 'systemTool', id: 'opencode-cli' },
          executablePath: '/opt/opencode',
        };
      },
    },
    run,
    async spawn() {
      throw new Error('spawn was not expected');
    },
    clients: {
      async spawn() {
        throw new Error('protocol client spawn was not expected');
      },
    },
  };
}

function processResult(params: Readonly<{
  exitCode: number;
  stdout?: string;
  stderr?: string;
}>): PluginProcessResult {
  return {
    termination: {
      observed: { kind: 'exit', exitCode: params.exitCode },
      requestedBy: { kind: 'none' },
    },
    stdout: Buffer.from(params.stdout ?? '', 'utf8'),
    stderr: Buffer.from(params.stderr ?? '', 'utf8'),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

describe('createOpenCodeHandoffSurfaceForExec', () => {
  it('skips vendor import and returns canonical session-state updates when the target export is semantically identical', async () => {
    const execRun = vi.fn(async () => processResult({
      exitCode: 0,
      stdout: JSON.stringify(buildVendorExport({ projectID: 'target-project' })),
    }));
    const surface = createOpenCodeHandoffSurfaceForExec(createExecFixture(execRun));

    const result = await surface.importBundle({
      bundle: {
        agentId: 'opencode',
        remoteSessionId: 'oc-import-1',
        exportJsonBase64: encodeExportPayload(buildVendorExport()),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: 'http://127.0.0.1:49196/',
          serverBaseUrlExplicit: true,
        },
      },
      targetDirectory: '/repo',
    });

    expect(execRun).toHaveBeenCalledOnce();
    expect(execRun).toHaveBeenCalledWith({
      executable: { kind: 'systemTool', id: 'opencode-cli' },
      args: ['export', 'oc-import-1'],
      cwd: { root: 'workspace', relativePath: '' },
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        providerSessionId: 'oc-import-1',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:49196/',
          directory: '/repo',
        },
        launch: {
          directory: '/repo',
          sessionStateUpdates: [
            {
              fieldId: 'identity.runtimeDescriptor',
              value: {
                v: 1,
                agentId: 'opencode',
                agent: {
                  backendMode: 'server',
                  providerSessionId: 'oc-import-1',
                  agentExtra: {
                    runtimeHandle: {
                      backendMode: 'server',
                      providerSessionId: 'oc-import-1',
                      serverBaseUrl: 'http://127.0.0.1:49196/',
                      serverBaseUrlExplicit: true,
                    },
                  },
                },
              },
            },
            {
              fieldId: 'identity.providerSessionId',
              value: 'oc-import-1',
            },
          ],
        },
      },
    });
  });

  it('rejects the vendor merge counterfactual when the target identity exists with divergent records and never imports', async () => {
    const execRun = vi.fn(async () => processResult({
      exitCode: 0,
      stdout: JSON.stringify(buildVendorExport({
        projectID: 'target-project',
        partText: 'divergent target content',
      })),
    }));
    const surface = createOpenCodeHandoffSurfaceForExec(createExecFixture(execRun));

    const result = await surface.importBundle({
      bundle: {
        agentId: 'opencode',
        remoteSessionId: 'oc-import-1',
        exportJsonBase64: encodeExportPayload(buildVendorExport()),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: null,
          serverBaseUrlExplicit: false,
        },
      },
      targetDirectory: '/repo',
    });

    expect(result).toEqual({
      ok: false,
      code: 'target_identity_conflict',
      message: 'OpenCode target session oc-import-1 already exists with divergent data',
    });
    expect(execRun).toHaveBeenCalledOnce();
    expect(execRun.mock.calls.some(([input]) => input.args?.[0] === 'import')).toBe(false);
  });

  it('fails closed for an absent target on OpenCode 1.14.41 because import is an unconditional merge', async () => {
    const execRun = vi.fn(async (input) => {
      if (input.args?.[0] === 'export') {
        return {
          ...processResult({
            exitCode: 1,
            stderr: 'Session not found: oc-import-1',
          }),
        };
      }
      if (input.args?.[0] === '--version') {
        return processResult({
          exitCode: 0,
          stdout: '1.14.41\n',
        });
      }
      throw new Error(`unexpected OpenCode command: ${input.args?.join(' ')}`);
    });
    const surface = createOpenCodeHandoffSurfaceForExec(createExecFixture(execRun));

    const result = await surface.importBundle({
      bundle: {
        agentId: 'opencode',
        remoteSessionId: 'oc-import-1',
        exportJsonBase64: encodeExportPayload(buildVendorExport()),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: null,
          serverBaseUrlExplicit: false,
        },
      },
      targetDirectory: '/repo',
    });

    expect(result).toEqual({
      ok: false,
      code: 'agent_version_unsupported',
      message: 'OpenCode 1.14.41 cannot safely create an absent handoff target',
    });
    expect(execRun.mock.calls).toEqual([
      [{
        executable: { kind: 'systemTool', id: 'opencode-cli' },
        args: ['export', 'oc-import-1'],
        cwd: { root: 'workspace', relativePath: '' },
        maxStdoutBytes: 16 * 1024 * 1024,
      }],
      [{
        executable: { kind: 'systemTool', id: 'opencode-cli' },
        args: ['--version'],
        cwd: { root: 'workspace', relativePath: '' },
      }],
    ]);
    expect(execRun.mock.calls.some(([input]) => input.args?.[0] === 'import')).toBe(false);
  });

  it('treats a target export that cannot be compared as an identity conflict without probing or importing', async () => {
    const execRun = vi.fn(async () => processResult({
      exitCode: 1,
      stderr: 'OpenCode database is unavailable',
    }));
    const surface = createOpenCodeHandoffSurfaceForExec(createExecFixture(execRun));

    const result = await surface.importBundle({
      bundle: {
        agentId: 'opencode',
        remoteSessionId: 'oc-import-1',
        exportJsonBase64: encodeExportPayload(buildVendorExport()),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: null,
          serverBaseUrlExplicit: false,
        },
      },
      targetDirectory: '/repo',
    });

    expect(result).toEqual({
      ok: false,
      code: 'target_identity_conflict',
      message: 'OpenCode target session oc-import-1 could not be compared safely',
    });
    expect(execRun).toHaveBeenCalledOnce();
    expect(execRun.mock.calls.some(([input]) => input.args?.[0] === 'import')).toBe(false);
  });

  it('reports a target import failure when the selected target directory cannot be used', async () => {
    const execRun = vi.fn(async () => {
      throw new Error('spawn cwd ENOENT');
    });
    const surface = createOpenCodeHandoffSurfaceForExec(createExecFixture(execRun));

    const result = await surface.importBundle({
      bundle: {
        agentId: 'opencode',
        remoteSessionId: 'oc-import-missing-target',
        exportJsonBase64: encodeExportPayload(buildVendorExport({
          sessionId: 'oc-import-missing-target',
        })),
        affinity: {
          backendMode: 'server',
          serverBaseUrl: null,
          serverBaseUrlExplicit: false,
        },
      },
      targetDirectory: '/missing/repo',
    });

    expect(result).toEqual({
      ok: false,
      code: 'target_import_failed',
      message: 'spawn cwd ENOENT',
    });
  });
});

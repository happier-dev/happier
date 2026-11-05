import { describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { ResolvedSystemTool } from '@happier-dev/plugin-sdk/exec';
import { encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createStubGithubTransport } from '../../triage/testkit/githubTriage.test-support.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate, activateAccount } from '../../activate.js';
import { inspectLocalActV1 } from './inspect.js';
import { runLocalActV1 } from './run.js';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' };
const selected = { workspace, workflowPath: '.github/workflows/ci.yml', event: 'push', yamlJobId: 'test',
  platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }], architecture: 'linux/amd64' };
const supportedHelp = '--workflows --job --eventpath --matrix --platform --container-architecture --secret --secret-file --env-file --var-file --input-file --var --artifact-server-path --json --insecure-secrets --rm --reuse';

function boundary(machineId = 'primary', helpFlags = supportedHelp, deferFilesystem = false,
  computeResult: unknown = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'review' }) {
  const calls: { id: string; input: unknown }[] = [];
  const transport = createStubGithubTransport({ respond: () => { throw new Error('Local flow must make zero hosted requests'); } });
  const observed = { status: 'ready', revision: 'absent', provenance: 'default',
    preference: { enabled: false, allowAdHoc: false, unavailable: 'ask', scriptOverrides: {} } };
  // Genuine host Action RPC and OS boundaries. Parser, argv builder and runtime stay real.
  const execute = vi.fn(async (id: string, input: unknown) => {
    calls.push({ id, input });
    if (id === 'projects.inspect') return { definition: { basis: { kind: 'absent' }, document: null },
      detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] };
    if (id === 'projects.worker.preferences.get') return observed;
    if (deferFilesystem && (id === 'daemon.filesystem.readFile' || id === 'daemon.filesystem.listDirectory')) {
      return { kind: 'approval_request_created', artifactId: 'filesystem-read-approval', actionId: id };
    }
    if (id === 'daemon.filesystem.readFile') return { success: true, content: encodeBase64(new TextEncoder().encode(
      'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo local\n')), eof: true };
    if (id === 'projects.compute.exec') return computeResult;
    throw new Error(`Unexpected Action ${id}`);
  }) as ActionsService['execute'];
  // Opaque executable handles are issued by the mocked host resolver, never authored by production code.
  const executable = Object.freeze({}) as ResolvedSystemTool['executable'];
  const resolve = vi.fn(async () => ({ executable, executablePath: '/tools/act' }));
  const run = vi.fn(async (input: { args?: readonly string[] }) => ({
    termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
    stdout: new TextEncoder().encode(input.args?.[0] === '--version' ? 'act version 0.2.89' : helpFlags),
    stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
  }));
  const context: PluginInvocationContext = { ...transport.context, services: { ...transport.context.services,
    actions: { ...transport.context.services.actions, execute,
      getCurrentExecutionRouting: async () => ({ serverIdentityId: 'home', machineId, pluginId: 'happier.scm.github' }) },
    exec: { ...transport.context.services.exec, systemTools: { resolve }, run },
  } };
  return { context, calls, resolve, run, observed, transport };
}

describe('local act invocation', () => {
  it('inspects one primary checkout with one preference read, two safe probes and no hosted/container calls', async () => {
    const h = boundary();
    const result = await inspectLocalActV1({ workspace, workflowPath: selected.workflowPath }, h.context);
    expect(result).toMatchObject({ workspace, tool: { kind: 'ready', executablePath: '/tools/act' },
      preference: { status: 'ready', preference: { allowAdHoc: false } },
      workflow: { events: ['push'], jobs: [{ id: 'test', runsOn: ['ubuntu-latest'] }] } });
    expect(h.calls.map(call => call.id)).toEqual(['projects.inspect', 'projects.worker.preferences.get', 'daemon.filesystem.readFile']);
    expect(h.run.mock.calls.map(([input]) => input.args)).toEqual([['--version'], ['--help']]);
    expect(h.transport.requests).toHaveLength(0);
  });
  it('refuses a remembered foreign Machine before executable/file/host effects', async () => {
    const h = boundary('worker');
    await expect(runLocalActV1(selected, h.context)).rejects.toMatchObject({ code: 'local_act_primary_machine_required' });
    expect(h.calls).toHaveLength(0); expect(h.resolve).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it.each(['--secret', '--var', '--artifact-server-path'])('refuses a tool missing the emitted %s flag before compute admission', async flag => {
    const h = boundary('primary', supportedHelp.split(' ').filter(value => value !== flag).join(' '));
    await expect(runLocalActV1(selected, h.context)).rejects.toMatchObject({ code: 'act_flags_unsupported' });
    expect(h.calls.some(call => call.id === 'projects.compute.exec')).toBe(false);
  });
  it.each([undefined, selected.workflowPath])('preserves a policy-deferred filesystem observation for workflow path %s', async workflowPath => {
    const h = boundary('primary', supportedHelp, true);
    expect(await inspectLocalActV1({ workspace, ...(workflowPath ? { workflowPath } : {}) }, h.context)).toEqual({
      kind: 'approval_request_created', artifactId: 'filesystem-read-approval',
      actionId: workflowPath ? 'daemon.filesystem.readFile' : 'daemon.filesystem.listDirectory',
    });
    expect(h.calls.some(call => call.id === 'projects.compute.exec')).toBe(false);
  });
  it.each(['system_tool_missing', 'plugin_permission_denied'])('preserves %s without another detector or executor fallback', async code => {
    const h = boundary(); h.resolve.mockRejectedValueOnce(new PluginError({ code }));
    const result = await inspectLocalActV1({ workspace, workflowPath: selected.workflowPath }, h.context);
    expect(result).toMatchObject({ tool: { kind: 'unavailable', code } });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.id === 'projects.compute.exec')).toBe(false);
    expect(h.transport.requests).toHaveLength(0);
  });
  it('delegates one primary command, preserves setup hold and never launches through Exec', async () => {
    const h = boundary();
    expect(await runLocalActV1(selected, h.context)).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_consent_required' });
    expect(h.calls.filter(call => call.id === 'projects.compute.exec')).toEqual([{ id: 'projects.compute.exec', input: expect.objectContaining({
      workspace, executable: '/tools/act', execution: 'primary', choice: { kind: 'primary' },
      argv: expect.arrayContaining(['--rm=true', '--reuse=false', '--insecure-secrets=false', '--secret=GITHUB_TOKEN=']),
    }) }]);
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it('rejects an invalid compute response before publishing a local-run result', async () => {
    const h = boundary('primary', supportedHelp, false, { kind: 'success' });
    await expect(runLocalActV1(selected, h.context)).rejects.toThrow();
    expect(h.calls.filter(call => call.id === 'projects.compute.exec')).toHaveLength(1);
  });
  it('registers the actual local handler with the declared run policy', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    try {
      const handler = kit.registration('actions', 'github/actions/local-run');
      expect(handler).toBeTypeOf('function');
      if (typeof handler !== 'function') throw new Error('Missing local-run registration');
      const h = boundary();
      await handler(selected, h.context);
      expect(h.calls.filter(call => call.id === 'projects.compute.exec')).toHaveLength(1);
      expect(PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === 'github/actions/local-run'))
        .toMatchObject({ dangerLevel: 'externalSideEffect', confirmationWhen: { presentUserUi: false }, confirmation: expect.any(Object) });
    } finally { await kit.dispose(); }
  });
});

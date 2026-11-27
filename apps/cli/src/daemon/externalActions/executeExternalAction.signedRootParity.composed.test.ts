import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { daemonPost } from '@/daemon/controlHttp';
import { SIGNED_ROOT_ACTION_EXECUTE_PATH } from './signedRootActionControl';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetFilesystemApprovalSocketBoundary();
  resetServerFeaturesClientForTests();
  withdrawActiveProjectAccountRowsSnapshot();
});

const cases = [
  ['deployments.environments.create', () => ({
    serverId: 'srv_n2', projectSourceId: 'source', requestKey: 'new-environment', name: 'Staging',
    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
    controllerMachineId: 'machine', definition: { from: 'repository', ref: 'main' },
  })],
  ['machines.reachability.inspect', () => ({ serverId: 'srv_n2', machineId: 'machine' })],
  ['projects.readiness.read', () => ({ serverId: 'srv_n2', machineId: 'machine', projectId: 'missing-project', environments: [] })],
  ['workflow.run.start', () => ({
    runId: randomUUID(), source: { kind: 'repo_file', path: 'missing.workflow.json' },
  })],
] as const satisfies readonly (readonly [ActionId, () => unknown])[];

it.each(['plugins.enable', 'plugins.disable', 'plugins.settings.get'] as const)(
  'preserves invalid_parameters for malformed %s across CLI and standalone MCP',
  async actionId => {
    const h = await createHarness(actionId, 'default', false, 'srv_n2', undefined, false, false, { authentication: 'account' });
    try {
      const input = { pluginId: 17 };
      const mcp = await h.runSavedProfileMcp(input, actionId, true);
      const root = await daemonPost(SIGNED_ROOT_ACTION_EXECUTE_PATH, { actionId, input, surface: 'mcp' });
      expect(root).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      const cli = await h.runOriginalCli(input, actionId);
      expect(cli).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      if (cli.ok) throw new Error('Expected a CLI Action input refusal');
      expect(mcp).toMatchObject({ errorCode: cli.errorCode });
      expect(h.networkPaths).not.toContain(`POST /v1/actions/${actionId}/execution-authorization`);
    } finally { await h.close(); }
  },
);

it('prepares the same requester Ask when CLI and standalone MCP Stop is addressed to a Sync endpoint', async () => {
  const actionId = 'workspace.sync.relationship.terminate';
  const h = await createHarness(actionId, 'default', false, 'srv_n2', undefined, true, false, { authentication: 'account' });
  try {
    const input = { relationshipId: h.workerRelationship.relationshipId, controllerMachineId: h.workerRef.machineId };
    const cli = await h.runOriginalCli(input, actionId);
    expect(cli).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
    const cliApproval = await h.approval();
    expect(cliApproval.actionArgs).toMatchObject({ controllerMachineId: h.workerRelationship.controllerMachineId });

    const mcp = await h.runSavedProfileMcp(input, actionId, true);
    expect(mcp).toMatchObject({ kind: 'approval_request_created', actionId });
    const mcpApproval = await h.approval();
    expect(mcpApproval.actionArgs).toEqual(cliApproval.actionArgs);
    expect(resolveApprovalExecutor(mcpApproval)).toEqual(resolveApprovalExecutor(cliApproval));
  } finally { await h.close(); }
});

it.each(cases)('preserves the CLI outcome and Home admission for standalone MCP %s', async (actionId, buildInput) => {
  const h = await createHarness(actionId, 'default');
  try {
    const input = buildInput();
    const cli = await h.runOriginalCli(input, actionId);
    const sinceCli = h.networkPaths.length;
    const mcp = await h.runSavedProfileMcp(input, actionId, true);
    const admission = `POST /v1/actions/${actionId}/execution-authorization`;
    const diagnostics = JSON.stringify({ cli, mcp, paths: h.networkPaths, outcomes: h.rpcOutcomes });
    expect(h.networkPaths.slice(0, sinceCli).filter(path => path === admission), diagnostics).toHaveLength(1);
    expect(h.networkPaths.slice(sinceCli).filter(path => path === admission), diagnostics).toHaveLength(1);
    if (cli.ok) {
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(cli.result);
      expect(mcp, diagnostics).toEqual(approval.success
        ? expect.objectContaining({ kind: approval.data.kind, actionId, artifactId: expect.any(String) }) : cli.result);
    } else {
      expect(['invalid_envelope', 'outcome_unknown'], diagnostics).not.toContain(cli.errorCode);
      expect(mcp, diagnostics).toMatchObject({ errorCode: cli.errorCode });
    }
  } finally { await h.close(); }
});

it('keeps CLI and standalone MCP Worker Copy retirement approval and replay with the requester', async () => {
  const actionId = 'projects.worker.copy.retire';
  const h = await createHarness(actionId, 'default', false, 'srv_n2', undefined, true, true);
  try {
    const input = { workspace: { serverId: 'srv_n2', refId: h.ref.id },
      machineId: 'machine', expectedRelationship: h.workerRelationship };
    const cli = await h.runOriginalCli(input, actionId);
    expect(cli).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
    const cliApproval = await h.approval();
    const mcp = await h.runSavedProfileMcp(input, actionId, true);
    expect(mcp).toMatchObject({ kind: 'approval_request_created', actionId });
    const mcpApproval = await h.approval();

    expect(cliApproval.actionArgs).toEqual(mcpApproval.actionArgs);
    const replayExecutor = resolveApprovalExecutor(cliApproval);
    expect(replayExecutor).toEqual({ kind: 'app', placement: 'machine' });
    expect(resolveApprovalExecutor(mcpApproval)).toEqual(replayExecutor);
    expect(cliApproval.executionOriginV1).toMatchObject({ accountId: 'account', surface: 'cli', authority: 'account_automation' });
    expect(mcpApproval.executionOriginV1).toMatchObject({ accountId: 'account', surface: 'mcp', authority: 'account_automation' });
    for (const { executionOriginV1: origin } of [cliApproval, mcpApproval]) {
      expect(origin.machineId).toBeUndefined();
      expect(origin.externalActionExecutionAuthorization).toBeUndefined();
    }
    expect(h.networkPaths).not.toContain(`POST /v1/actions/${actionId}/execution-authorization`);
    expect(h.networkPaths.filter(path => path === 'POST /v1/artifacts')).toHaveLength(2);
  } finally { await h.close(); }
});

it.each(['cli', 'mcp'] as const)('retains one pending Install & Trust approval from %s on its Home-admitted Machine', async surface => {
  const actionId = 'plugins.install';
  const h = await createHarness(actionId, 'default', false, 'srv_n2', undefined, false, false, { authentication: 'account' });
  try {
    const manifestDir = join(h.rootPath, '.happier-plugin');
    await mkdir(manifestDir);
    await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
      id: 'fixture.ingress', entrypoints: undefined, engines: undefined,
    })));
    const input = { path: h.rootPath, machineId: 'machine' };
    const cli = surface === 'cli' ? await h.runOriginalCli(input, actionId) : undefined;
    const result = cli ? (cli.ok ? cli.result : cli) : await h.runSavedProfileMcp(input, actionId, true);
    const diagnostic = JSON.stringify({ result, paths: h.networkPaths, outcomes: h.rpcOutcomes });
    expect(h.networkPaths.filter(path => path === `POST /v1/actions/${actionId}/execution-authorization`), diagnostic).toHaveLength(1);
    expect(result, diagnostic)
      .toMatchObject({ kind: 'approval_request_created', actionId, artifactId: expect.any(String) });
    expect(h.networkPaths.filter(path => path === 'POST /v1/artifacts')).toHaveLength(1);
  } finally { await h.close(); }
});

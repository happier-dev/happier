import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
import { decodeBase64, ProtocolProjectDefinitionInspectOutputSchema,
  ProtocolWorkspaceWorkerPreferenceReadResultV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { parseGithubWorkflowDefinitionV1 } from '../workflowDefinition.js';
import { LocalActInspectInputV1Schema, type LocalActInspection } from './contracts.js';

const requiredFlags = ['--workflows', '--job', '--eventpath', '--matrix', '--platform', '--container-architecture',
  '--secret', '--secret-file', '--env-file', '--var-file', '--input-file', '--var', '--artifact-server-path',
  '--json', '--insecure-secrets', '--rm', '--reuse'];

export async function assertLocalActMachineV1(context: PluginInvocationContext, machineId: string): Promise<void> {
  const routing = await context.services.actions.getCurrentExecutionRouting?.({ signal: context.signal });
  if (!routing || routing.machineId !== machineId) throw new PluginError({ code: 'local_act_primary_machine_required' });
}

/** Safe demand-only inspection. act --list initializes credentials and is never used. */
export async function inspectLocalActV1(input: unknown, context: PluginInvocationContext): Promise<LocalActInspection | ActionApprovalRequestCreatedResult> {
  const admitted = LocalActInspectInputV1Schema.parse(input);
  const { workspace } = admitted;
  await assertLocalActMachineV1(context, workspace.machineId);
  const preferenceAddress = { serverId: workspace.serverId, refId: workspace.workspaceId };
  const [projectResult, preferenceResult] = await Promise.all([
    context.services.actions.execute('projects.inspect', { workspace }, { signal: context.signal }),
    context.services.actions.execute('projects.worker.preferences.get', { workspace: preferenceAddress }, { signal: context.signal }),
  ]);
  // Safe reads can still be explicitly denied/asked by the Account's policy.
  if (isPluginActionApprovalRequestCreated(projectResult)) return projectResult;
  if (isPluginActionApprovalRequestCreated(preferenceResult)) return preferenceResult;
  const project = ProtocolProjectDefinitionInspectOutputSchema.parse(projectResult);
  const preference = ProtocolWorkspaceWorkerPreferenceReadResultV1Schema.parse(preferenceResult);
  let tool: LocalActInspection['tool'];
  try {
    const resolved = await context.services.exec.systemTools.resolve({ toolId: 'act', purpose: 'Inspect installed act for a local workflow run',
      cwd: workspace.rootPath, signal: context.signal });
    const [version, help] = await Promise.all(['--version', '--help'].map(flag => context.services.exec.run({
      executable: resolved.executable, args: [flag], cwd: workspace.rootPath,
    }, { signal: context.signal })));
    const observedHelp = new TextDecoder().decode(help!.stdout);
    const supportedFlags = new Set(observedHelp.match(/--[a-z][a-z0-9-]*/giu) ?? []);
    const succeeded = (result: typeof help) => result!.termination.observed.kind === 'exit' && result!.termination.observed.exitCode === 0;
    tool = succeeded(version) && succeeded(help) && !help!.stdoutTruncated && requiredFlags.every(flag => supportedFlags.has(flag))
      ? { kind: 'ready', executablePath: resolved.executablePath, version: new TextDecoder().decode(version!.stdout).trim() || 'act' }
      : { kind: 'unavailable', code: 'act_flags_unsupported' };
  } catch (error) {
    tool = { kind: 'unavailable', code: error instanceof PluginError ? error.code : 'act_unavailable' };
  }
  if (context.signal.aborted) throw new PluginError({ code: 'local_act_inspection_cancelled' });
  if (project.definition.document?.status === 'invalid') throw new PluginError({ code: 'invalid_manifest' });
  const secretRequirements = project.definition.document?.status === 'valid'
    ? (project.definition.document.manifest.environmentVariables ?? []).filter(requirement => requirement.kind === 'secret') : [];
  const base = { workspace, tool, preferenceAddress, preference, secretRequirements };
  if (admitted.workflowPath === undefined) {
    const listing = await context.services.actions.execute('daemon.filesystem.listDirectory', {
      rootPath: workspace.rootPath, path: '.github/workflows',
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(listing)) return listing;
    if (!listing.success) return { ...base, workflows: [], workflowError: 'workflow_listing_unavailable' };
    return { ...base, workflows: listing.entries.filter(entry => entry.type === 'file' && /^[^/\\]+\.ya?ml$/u.test(entry.name))
      .map(entry => `.github/workflows/${entry.name}`), ...(listing.truncated ? { workflowError: 'workflow_listing_incomplete' } : {}) };
  }
  const result = await context.services.actions.execute('daemon.filesystem.readFile', {
    rootPath: workspace.rootPath, path: admitted.workflowPath,
  }, { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(result)) return result;
  if (!result.success || result.eof === false) {
    return { ...base, workflows: [admitted.workflowPath], workflowPath: admitted.workflowPath, workflowError: 'workflow_read_unavailable' };
  }
  try {
    const parsed = parseGithubWorkflowDefinitionV1(decodeBase64(result.content));
    return { ...base, workflows: [admitted.workflowPath], workflowPath: admitted.workflowPath,
      workflow: { events: parsed.triggers, jobs: parsed.jobs } };
  } catch {
    return { ...base, workflows: [admitted.workflowPath], workflowPath: admitted.workflowPath, workflowError: 'workflow_definition_unsupported' };
  }
}

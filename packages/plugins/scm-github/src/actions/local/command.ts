import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { LocalActWorkflow, LocalRunSelection } from './contracts.js';

export type LocalActRunnerRequirementsV1 = Readonly<{ kind: 'ready'; labels: readonly string[] }>
  | Readonly<{ kind: 'refused'; code: 'job_not_found' | 'dynamic_runner_unsupported'
    | 'native_runner_unsupported' | 'image_mapping_required' }>;

/** One traversal owns both the required image fields and launch admission. */
function readRunnerRequirements(workflow: LocalActWorkflow, yamlJobId: string | undefined,
  images?: ReadonlyMap<string, string>): LocalActRunnerRequirementsV1 {
  const jobs = new Map(workflow.jobs.map(job => [job.id, job]));
  const pending = yamlJobId ? [yamlJobId] : [...jobs.keys()];
  if (pending.length === 0) return { kind: 'refused', code: 'job_not_found' };
  const visited = new Set<string>();
  const labels = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const job = jobs.get(id);
    if (!job) return { kind: 'refused', code: 'job_not_found' };
    if (job.runsOn === 'dynamic' || job.runsOn.length === 0) return { kind: 'refused', code: 'dynamic_runner_unsupported' };
    for (const label of job.runsOn) {
      if (/^(?:windows|macos)(?:-|$)/iu.test(label)) return { kind: 'refused', code: 'native_runner_unsupported' };
      if (images && !images.has(label)) return { kind: 'refused', code: 'image_mapping_required' };
      labels.add(label);
    }
    pending.push(...job.needs);
  }
  return { kind: 'ready', labels: [...labels] };
}

/** Mounted producer baseline, not a second workflow engine or a consumer cache. */
export function projectLocalActRunnerRequirementsV1(workflow: LocalActWorkflow, yamlJobId: string | undefined,
  previous: LocalActRunnerRequirementsV1 | null): LocalActRunnerRequirementsV1 {
  const next = readRunnerRequirements(workflow, yamlJobId);
  if (next.kind === 'ready' && previous?.kind === 'ready' && next.labels.length === previous.labels.length
    && next.labels.every((label, index) => label === previous.labels[index])) return previous;
  if (next.kind === 'refused' && previous?.kind === 'refused' && next.code === previous.code) return previous;
  return next;
}

/** The parser supplies facts, not an alternate workflow execution engine. */
export function validateLocalActWorkflowSelectionV1(selection: LocalRunSelection, workflow: LocalActWorkflow):
  { kind: 'ready' } | { kind: 'refused'; code: string } {
  if (!workflow.events.includes(selection.event)) return { kind: 'refused', code: 'event_not_found' };
  const requirements = readRunnerRequirements(workflow, selection.yamlJobId,
    new Map(selection.platforms.map(mapping => [mapping.label, mapping.image])));
  return requirements.kind === 'refused' ? requirements : { kind: 'ready' };
}

/** Only explicit Run constructs argv; values never pass through a shell. */
export function buildLocalActCommandV1(selection: LocalRunSelection, executable: string): PluginActionInputById['projects.compute.exec'] & { execution: 'primary' } {
  if (!selection.workflowPath.trim() || !selection.event.trim() || !selection.architecture.trim()) throw new Error('local_act_selection_incomplete');
  const argv = [selection.event, `--workflows=${selection.workflowPath}`];
  if (selection.yamlJobId) argv.push(`--job=${selection.yamlJobId}`);
  if (selection.eventPath) argv.push(`--eventpath=${selection.eventPath}`);
  for (const value of selection.matrix ?? []) argv.push(`--matrix=${value}`);
  const labels = new Set<string>();
  for (const { label, image } of selection.platforms) {
    if (!image.trim() || image.trim().startsWith('-') || labels.has(label)) throw new Error('invalid_image_mapping');
    labels.add(label);
    argv.push(`--platform=${label}=${image}`);
  }
  argv.push(`--container-architecture=${selection.architecture}`);
  for (const { name, value } of selection.variables ?? []) argv.push(`--var=${name}=${value}`);
  if (selection.artifactServerPath) argv.push(`--artifact-server-path=${selection.artifactServerPath}`);
  argv.push(`--secret-file=${selection.secretFilePath ?? ''}`, '--env-file=', '--var-file=', '--input-file=');
  const names = Object.keys(selection.environmentBindings?.bindings ?? {}).sort();
  for (const name of names) argv.push(`--secret=${name}`);
  if (!names.includes('GITHUB_TOKEN')) argv.push('--secret=GITHUB_TOKEN=');
  argv.push('--json=false', '--insecure-secrets=false', '--rm=true', '--reuse=false');
  return { workspace: selection.workspace, executable, argv, cwd: selection.workspace.rootPath,
    execution: 'primary', choice: { kind: 'primary' },
    ...(selection.environmentBindings ? { environmentBindings: selection.environmentBindings } : {}),
  };
}

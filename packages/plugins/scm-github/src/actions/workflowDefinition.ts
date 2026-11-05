import { parseDocument } from 'yaml';
import type { ForgeCiTriggerInputV1, ForgeCiWorkflowJobV1 } from '@happier-dev/triage-protocol/ci/v1';
import { githubRecord } from './mapping.js';

export type GithubWorkflowDefinitionV1 = Readonly<{
  name?: string;
  triggers: readonly string[];
  dispatchable: boolean;
  inputs: readonly ForgeCiTriggerInputV1[];
  jobs: readonly ForgeCiWorkflowJobV1[];
}>;
export class GithubWorkflowDefinitionError extends Error {
  readonly code = 'github_workflow_definition_unsupported';
}
const expression = (value: string) => value.includes('${{');

/** Supplied bytes only. No network, expression evaluation, shell or matrix expansion. */
export function parseGithubWorkflowDefinitionV1(bytes: Uint8Array | string): GithubWorkflowDefinitionV1 {
  const source = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const document = parseDocument(source, { version: '1.2', uniqueKeys: true, stringKeys: true, merge: true });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new GithubWorkflowDefinitionError('The workflow YAML could not be projected.');
  // yaml is an untyped external conversion boundary. Narrow its result before use.
  const converted: unknown = document.toJS();
  const raw = githubRecord(converted);
  let triggers: string[];
  let dispatch: unknown;
  if (typeof raw.on === 'string') triggers = [raw.on];
  else if (Array.isArray(raw.on) && raw.on.every(value => typeof value === 'string')) triggers = raw.on;
  else {
    const on = githubRecord(raw.on);
    triggers = Object.keys(on); dispatch = on.workflow_dispatch;
  }
  const dispatchable = triggers.includes('workflow_dispatch');
  const inputs: ForgeCiTriggerInputV1[] = [];
  if (dispatchable && dispatch != null) {
    const definition = githubRecord(dispatch);
    const fields = definition.inputs == null ? {} : githubRecord(definition.inputs);
    for (const [name, value] of Object.entries(fields)) {
      const field = githubRecord(value);
      const type = field.type;
      if (type !== 'string' && type !== 'boolean' && type !== 'number' && type !== 'choice' && type !== 'environment') throw new GithubWorkflowDefinitionError(`Input ${name} has an unsupported type.`);
      if (field.required !== undefined && typeof field.required !== 'boolean') throw new GithubWorkflowDefinitionError(`Input ${name} has invalid required metadata.`);
      if (field.description !== undefined && typeof field.description !== 'string') throw new GithubWorkflowDefinitionError(`Input ${name} has an invalid description.`);
      let options: string[] | undefined;
      if (type === 'choice') {
        if (!Array.isArray(field.options) || field.options.length === 0 || !field.options.every(value => typeof value === 'string') || new Set(field.options).size !== field.options.length) throw new GithubWorkflowDefinitionError(`Input ${name} has invalid choices.`);
        options = field.options;
      } else if (field.options !== undefined) throw new GithubWorkflowDefinitionError(`Input ${name} has unsupported choices.`);
      const defaultValue = field.default;
      if (defaultValue !== undefined && (type === 'boolean' ? typeof defaultValue !== 'boolean'
        : type === 'number' ? typeof defaultValue !== 'number' || !Number.isFinite(defaultValue)
          : typeof defaultValue !== 'string' || (type === 'choice' && !options?.includes(defaultValue)))) throw new GithubWorkflowDefinitionError(`Input ${name} has an invalid default.`);
      inputs.push({ name, type, ...(typeof field.description === 'string' ? { description: field.description } : {}),
        ...(typeof field.required === 'boolean' ? { required: field.required } : {}),
        ...(defaultValue === undefined ? {} : { default: defaultValue as string | number | boolean }), ...(options === undefined ? {} : { options }) });
    }
  }
  const jobs = Object.entries(raw.jobs === undefined ? {} : githubRecord(raw.jobs)).map(([id, value]) => {
    const job = githubRecord(value);
    const needs = job.needs === undefined ? [] : typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (!Array.isArray(needs) || !needs.every(value => typeof value === 'string') || needs.some(expression)) throw new GithubWorkflowDefinitionError(`Job ${id} has dynamic dependencies.`);
    const runner = job['runs-on'];
    const labels = typeof runner === 'string' ? [runner] : Array.isArray(runner) && runner.every(value => typeof value === 'string') ? runner : null;
    return { id, needs, runsOn: labels !== null && !labels.some(expression) ? labels : 'dynamic' as const };
  });
  return Object.freeze({ ...(typeof raw.name === 'string' ? { name: raw.name } : {}), triggers, dispatchable, inputs, jobs });
}

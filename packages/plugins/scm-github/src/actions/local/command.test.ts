import { describe, expect, it } from 'vitest';
import { LocalActRunFormInputV1Schema, LocalRunSelectionV1Schema } from './contracts.js';
import { buildLocalActCommandV1, validateLocalActWorkflowSelectionV1 } from './command.js';

export const selection = {
  workspace: { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' },
  workflowPath: '.github/workflows/ci.yml', event: 'push', yamlJobId: 'test',
  platforms: [{ label: 'ubuntu-latest', image: 'ghcr.io/example/runner:reviewed' }], architecture: 'linux/amd64',
};
const workflow = { events: ['push'], jobs: [
  { id: 'build', needs: [], runsOn: ['ubuntu-latest'] },
  { id: 'test', needs: ['build'], runsOn: ['ubuntu-latest'] },
] };

describe('local act reviewed operands', () => {
  it('uses argv, overrides inherited output/secret/cleanup controls and fixes primary execution', () => {
    const result = buildLocalActCommandV1({ ...selection, eventPath: 'fixtures/event with spaces.json',
      matrix: ['node:22'], variables: [{ name: 'MODE', value: 'a; echo literal' }],
      secretFilePath: '/machine/private file', artifactServerPath: '/machine/artifacts',
    }, '/tools/act');
    expect(result).toMatchObject({ executable: '/tools/act', cwd: '/repo', execution: 'primary', choice: { kind: 'primary' } });
    expect(result.argv).toEqual(['push', '--workflows=.github/workflows/ci.yml', '--job=test',
      '--eventpath=fixtures/event with spaces.json', '--matrix=node:22',
      '--platform=ubuntu-latest=ghcr.io/example/runner:reviewed', '--container-architecture=linux/amd64',
      '--var=MODE=a; echo literal', '--artifact-server-path=/machine/artifacts',
      '--secret-file=/machine/private file', '--env-file=', '--var-file=', '--input-file=',
      '--secret=GITHUB_TOKEN=', '--json=false', '--insecure-secrets=false', '--rm=true', '--reuse=false']);
  });
  it('passes only selected secret names and preserves declared references without values', () => {
    const input = LocalRunSelectionV1Schema.parse({ ...selection, environmentBindings: { v: 1,
      bindings: { GITHUB_TOKEN: { ref: 'personal-token' }, API_KEY: { ref: 'personal-key' } } } });
    const result = buildLocalActCommandV1(input, '/tools/act');
    expect(result.argv).toContain('--secret=GITHUB_TOKEN');
    expect(result.argv).toContain('--secret=API_KEY');
    expect(result.argv).not.toContain('--secret=GITHUB_TOKEN=');
    expect(result.environmentBindings).toBe(input.environmentBindings);
    expect(JSON.stringify(result.argv)).not.toContain('personal-token');
    expect(JSON.stringify(result.argv)).not.toContain('personal-key');
  });
  it('requires static selected/dependency runners and exact YAML keys rather than hosted ids', () => {
    expect(validateLocalActWorkflowSelectionV1(selection, workflow)).toEqual({ kind: 'ready' });
    expect(validateLocalActWorkflowSelectionV1({ ...selection, yamlJobId: '123' }, workflow)).toMatchObject({ kind: 'refused', code: 'job_not_found' });
    expect(validateLocalActWorkflowSelectionV1({ ...selection, platforms: [] }, workflow)).toMatchObject({ kind: 'refused', code: 'image_mapping_required' });
    expect(validateLocalActWorkflowSelectionV1(selection, { ...workflow, jobs: [
      { ...workflow.jobs[0]!, runsOn: 'dynamic' }, workflow.jobs[1]!,
    ] })).toMatchObject({ kind: 'refused', code: 'dynamic_runner_unsupported' });
    expect(() => buildLocalActCommandV1({ ...selection, platforms: [{ label: 'ubuntu-latest', image: '-self-hosted' }] }, '/tools/act')).toThrow();
  });
  it('keeps open and mounted envelopes closed and accepts no execution/raw-secret escape', () => {
    const seed = { target: { kind: 'project', projectId: 'project-workflows' }, workspace: selection.workspace };
    expect(LocalActRunFormInputV1Schema.safeParse({ operation: { kind: 'open', seed } }).success).toBe(true);
    expect(LocalActRunFormInputV1Schema.safeParse({ mountId: 'mount', operation: { kind: 'setSelection', selection } }).success).toBe(true);
    expect(LocalActRunFormInputV1Schema.safeParse({ operation: { kind: 'open', seed: { ...seed, hostedContext: {} } } }).success).toBe(false);
    expect(LocalRunSelectionV1Schema.safeParse({ ...selection, extraArgv: ['--privileged'] }).success).toBe(false);
    expect(LocalRunSelectionV1Schema.safeParse({ ...selection, secret: 'raw-value' }).success).toBe(false);
    expect(LocalActRunFormInputV1Schema.safeParse({ operation: { kind: 'open', seed: { ...seed, sourceHeadSha: 'job-123' } } }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { parseGithubWorkflowDefinitionV1 } from './workflowDefinition.js';
import { validateGithubWorkflowInputsV1 } from './dispatch.js';

describe('supplied GitHub workflow bytes', () => {
  it('preserves omission for native input names that overlap object prototype fields', () => {
    const definition = parseGithubWorkflowDefinitionV1('on: {workflow_dispatch: {inputs: {constructor: {type: string}}}}');
    expect(() => validateGithubWorkflowInputsV1(definition, {})).not.toThrow();
  });
  it('projects YAML 1.2 dispatch fields and real sparse dependency keys without evaluating expressions', () => {
    const definition = parseGithubWorkflowDefinitionV1(new TextEncoder().encode(`name: CI
on:
  push:
  workflow_dispatch:
    inputs:
      flag: {type: boolean, default: false, required: true}
      retries: {type: number, default: 0}
      mode: {type: choice, options: [fast, full], default: fast}
      target: {type: environment}
jobs:
  build: {runs-on: [self-hosted, linux]}
  test: {needs: build, runs-on: ubuntu-latest}
  ship: {needs: [build, test], runs-on: '${'${{ inputs.runner }}'}'}
`));
    expect(definition.triggers).toEqual(['push', 'workflow_dispatch']);
    expect(definition.inputs).toEqual([
      { name: 'flag', type: 'boolean', default: false, required: true },
      { name: 'retries', type: 'number', default: 0 },
      { name: 'mode', type: 'choice', options: ['fast', 'full'], default: 'fast' },
      { name: 'target', type: 'environment' },
    ]);
    expect(definition.jobs).toEqual([
      { id: 'build', needs: [], runsOn: ['self-hosted', 'linux'] },
      { id: 'test', needs: ['build'], runsOn: ['ubuntu-latest'] },
      { id: 'ship', needs: ['build', 'test'], runsOn: 'dynamic' },
    ]);
  });
  it.each(['on: workflow_dispatch', 'on: [push, workflow_dispatch]', 'on: {workflow_dispatch: null}'])('accepts zero-field dispatch: %s', source => {
    expect(parseGithubWorkflowDefinitionV1(source)).toMatchObject({ dispatchable: true, inputs: [] });
  });
  it.each([
    'on: push\non: workflow_dispatch',
    'on: {workflow_dispatch: {inputs: {x: {type: boolean, default: "false"}}}}',
    'on: {workflow_dispatch: {inputs: {x: {type: choice, options: [a, a]}}}}',
    'on: {workflow_dispatch: {inputs: {x: {type: choice, options: [a], default: b}}}}',
    'on: {workflow_dispatch: {inputs: {x: {type: secret}}}}',
  ])('refuses a malformed or unsupported input form rather than inventing empty inputs', source => {
    expect(() => parseGithubWorkflowDefinitionV1(source)).toThrow();
  });
});

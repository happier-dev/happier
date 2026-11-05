import { describe, expect, it } from 'vitest';
import { githubLocalRunOpenIntentV1 } from './localRunEntry.js';

describe('workflow and selected-job local form seed', () => {
  it('uses only the admitted checkout and proven YAML job key; numeric hosted job IDs stay absent', () => {
    const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' };
    const target = { kind: 'project', projectId: 'project-workflows' } as const;
    const definition = { triggers: ['push'], dispatchable: false, inputs: [], jobs: [{ id: 'test', needs: [], runsOn: ['ubuntu-latest'] }] } as const;
    expect(githubLocalRunOpenIntentV1({ target, workspace, workflowPath: '.github/workflows/ci.yml', sourceHeadSha: 'a'.repeat(40), definition, yamlJobId: '91' })).toEqual({ operation: { kind: 'open', seed: { target, workspace, workflowPath: '.github/workflows/ci.yml', sourceHeadSha: 'a'.repeat(40) } } });
    expect(githubLocalRunOpenIntentV1({ target, workspace, workflowPath: '.github/workflows/ci.yml', definition, yamlJobId: 'test', event: 'push' })).toMatchObject({ operation: { seed: { target, yamlJobId: 'test', event: 'push' } } });
  });
});

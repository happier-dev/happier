import { describe, expect, it } from 'vitest';
import { DeploymentPrepareInputV1Schema } from './deploymentPreparationV1.js';

const source = {
  projectSourceId: 'source', sourceRevision: 1,
  repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
  baseCommit: 'a'.repeat(40),
  workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' },
};

describe('Prepare reviewed Session and import references', () => {
  it('retains an exact existing Session and reference-only import intent through public input parsing', () => {
    const input = { ...source, sessionRef: { serverId: 'home', sessionId: 'existing-session' },
      importFrom: { tool: 'Previous manager', configurationPaths: ['app.json', 'deploy/compose.yaml'] } };
    expect(DeploymentPrepareInputV1Schema.parse(input)).toEqual(input);
    expect(DeploymentPrepareInputV1Schema.parse(source)).toEqual(source);
  });

  it('rejects inline imported material and credentials instead of silently dropping them', () => {
    const input = { ...source, importFrom: { tool: 'Previous manager', configurationPaths: ['app.json'],
      configuration: { password: 'not-session-input' } } };
    expect(DeploymentPrepareInputV1Schema.safeParse(input).success).toBe(false);
  });
});

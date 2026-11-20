import { describe, expect, it } from 'vitest';

import { SessionPlacementSelectionV1Schema } from './sessionPlacementSelectionV1.js';
import { SessionSpawnNewInputV2Schema } from './sessionSpawnNewInputV2.js';
import { sessionProjectFilesOpenChildrenV1 } from './sessionProjectFilesOpenV1.js';
import { computeWorkspaceSyncPolicyDigest } from '../control/handoff/workspaceSyncSchemas.js';

describe('Session Project files placement transport', () => {
  it('admits the exact in-place Project workspace independently of copied files', () => {
    const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'project-checkout',
      managedId: 'guest', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/guest/project' };
    const sessionPlacement = { kind: 'in_place', workspace };
    const input = { executionTarget: { serverId: 'home', machineId: 'controller' },
      directory: { kind: 'path', path: workspace.rootPath },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, sessionPlacement };
    const parsed = SessionSpawnNewInputV2Schema.parse(input);
    expect(parsed.sessionPlacement).toEqual(sessionPlacement);
    expect(sessionProjectFilesOpenChildrenV1({ ...parsed, projectFiles: { kind: 'git_clone' } })).toEqual([]);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input, executionTarget: { ...input.executionTarget, machineId: 'other' } }).success).toBe(false);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...input,
      sessionPlacement: { ...sessionPlacement, projectFiles: { kind: 'copy_once' } } }).success).toBe(false);
  });

  it('retains a qualified Git Account without storing credentials', () => {
    const selection = { kind: 'managed', projectFiles: { kind: 'git_clone', branch: 'feature/dirty-work',
      source: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/project' }, protocol: 'https' },
      gitAccount: { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' },
    } };
    expect(SessionPlacementSelectionV1Schema.parse(selection)).toEqual(selection);
    expect(SessionPlacementSelectionV1Schema.safeParse({ ...selection,
      projectFiles: { ...selection.projectFiles, gitAccount: { ...selection.projectFiles.gitAccount, token: 'must-not-persist' } } }).success).toBe(false);
  });
  it.each(['copy_once', 'sync'] as const)('retains the selected Included policy for %s', kind => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: ['private/**'], extraIncludePatterns: ['build/result.txt'] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const selection = { kind: 'managed', projectFiles: { kind, ...(kind === 'sync' ? { mode: 'keep_both_in_sync' } : {}), contentPolicy } };
    expect(SessionPlacementSelectionV1Schema.parse(selection)).toEqual(selection);
  });
  it.each([
    { kind: 'machine', target: { serverId: 'home', machineId: 'machine' } },
    { kind: 'preset', homeId: 'home', presetId: 'preset' },
    { kind: 'managed' },
  ])('retains an explicit file choice in $kind placement', placement => {
    const selected = { ...placement, projectFiles: { kind: 'sync', mode: 'keep_both_in_sync' } };
    expect(SessionPlacementSelectionV1Schema.parse(selected)).toEqual(selected);
  });
  it('retains the source Machine and folder independently of a default file choice', () => {
    const selection = { kind: 'managed', projectFilesSource: {
      target: { serverId: 'home', machineId: 'source-machine' }, directory: '/source/project',
    } };
    expect(SessionPlacementSelectionV1Schema.parse(selection)).toEqual(selection);
  });
});

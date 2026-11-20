import { describe, expect, it } from 'vitest';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec } from '../../actions/actionSpecs.js';
import { SessionSpawnNewInputV2Schema } from './sessionSpawnNewInputV2.js';
import { needsEnrolledSessionProjectFilesOpenV1, sessionProjectFilesOpenChildrenV1 } from './sessionProjectFilesOpenV1.js';
import type { SessionProjectFilesV1 } from './sessionPlacementSelectionV1.js';

const source = { target: { serverId: 'home', machineId: 'original' }, directory: '/chosen/project' };
const input = SessionSpawnNewInputV2Schema.parse({
  executionTarget: { serverId: 'home', machineId: 'remote' },
  directory: { kind: 'path', path: source.directory },
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  sessionPlacement: { kind: 'machine', target: { serverId: 'home', machineId: 'remote' }, projectFilesSource: source },
});

describe('Session Project files source admission', () => {
  it('admits a trusted clone default while keeping an authored choice authoritative', () => {
    const projectFiles: SessionProjectFilesV1 = { kind: 'git_clone', branch: 'main', source: {
      provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/project', cloneUrl: 'https://github.com/owner/project.git' }, protocol: 'https',
    } };
    expect(sessionProjectFilesOpenChildrenV1({ executionTarget: input.executionTarget, projectFiles })).toEqual([
      { action: 'projects.open', role: 'session_project_files_target', scopeInput: input.executionTarget },
    ]);
    expect(needsEnrolledSessionProjectFilesOpenV1({ executionTarget: input.executionTarget, projectFiles })).toBe(true);
    expect(needsEnrolledSessionProjectFilesOpenV1({ executionTarget: input.executionTarget, projectFiles,
      placement: { kind: 'machine', target: input.executionTarget, projectFiles: { kind: 'copy_once' } } })).toBe(false);
  });
  it('retains requester Account content custody for the nested Project checkout owners', () => {
    expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId: 'session.spawn_new', input })).toBe(true);
  });
  it('declares original-folder admission separately from destination materialization', () => {
    const declare = getActionSpec('session.spawn_new').hostReviewedChildren;
    const children = typeof declare === 'function' ? declare(input) : declare;
    expect(children).toEqual([
      { action: 'projects.open', role: 'session_project_files_source', input: {
        serverId: 'home', machineId: 'original', source: { kind: 'folder', path: '/chosen/project' },
        materialization: { kind: 'attach' },
      } },
      { action: 'projects.open', role: 'session_project_files_source', input: {
        serverId: 'home', machineId: 'original', source: { kind: 'folder', path: '/chosen/project' },
        materialization: { kind: 'attach' }, cloneSource: true,
      } },
      { action: 'projects.open', role: 'session_project_files_target',
        scopeInput: { serverId: 'home', machineId: 'remote' } },
    ]);
  });

  it('opens the exact managed workspace when copying to its own controller', () => {
    const workspace = {
      v: 2, kind: 'managed', serverId: 'home', workspaceId: 'guest-ref', managedId: 'guest-id',
      controller: { machineId: 'remote', installationId: 'controller-installation' }, rootPath: '/guest/project',
    } as const;
    const spawn = SessionSpawnNewInputV2Schema.parse({
      ...input, directory: { kind: 'path', path: '/controller/copy' },
      sessionPlacement: {
        kind: 'machine', target: input.executionTarget,
        projectFilesSource: { kind: 'managed', workspace },
        projectFiles: { kind: 'copy_once' },
      },
    });
    expect(needsEnrolledSessionProjectFilesOpenV1({
      executionTarget: spawn.executionTarget, placement: spawn.sessionPlacement,
    })).toBe(true);
    expect(sessionProjectFilesOpenChildrenV1(spawn)).toEqual([
      { action: 'projects.open', role: 'session_project_files_source', input: {
        ...input.executionTarget,
        source: { kind: 'workspace', workspaceId: workspace.workspaceId, checkout: workspace },
        materialization: { kind: 'attach' },
      } },
      { action: 'projects.open', role: 'session_project_files_target', scopeInput: input.executionTarget },
    ]);
  });

  it('admits the target Project owner when policy selects a native sandbox on the source controller', () => {
    const declare = getActionSpec('session.spawn_new').hostReviewedChildren;
    const direct = { ...input, sessionPlacement: { ...input.sessionPlacement!, projectFilesSource: {
      ...source, target: input.executionTarget,
    } } };
    expect(typeof declare === 'function' ? declare(direct) : declare).toEqual([
      { action: 'projects.open', role: 'session_project_files_source', input: {
        serverId: 'home', machineId: 'remote', source: { kind: 'folder', path: '/chosen/project' },
        materialization: { kind: 'attach' },
      } },
      { action: 'projects.open', role: 'session_project_files_source', input: {
        serverId: 'home', machineId: 'remote', source: { kind: 'folder', path: '/chosen/project' },
        materialization: { kind: 'attach' }, cloneSource: true,
      } },
      { action: 'projects.open', role: 'session_project_files_target',
        scopeInput: { serverId: 'home', machineId: 'remote' } },
    ]);
    expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId: 'session.spawn_new', input: direct })).toBe(true);
  });
});

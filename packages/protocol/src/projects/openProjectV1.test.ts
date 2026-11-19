import { describe, expect, it } from 'vitest';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema, WorkspaceActivationRequestV1Schema } from './openProjectV1.js';
import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';

describe('OpenProject V1 wire admission', () => {
  it('admits a managed folder attach only through the chosen controller', () => {
    const input = { serverId: 'home', machineId: 'controller', source: { kind: 'folder', path: '/guest/project' },
      materialization: { kind: 'attach',
        targetManaged: { managedId: 'row', controller: { machineId: 'controller', installationId: 'installation' } } } };
    expect(OpenProjectInputV1Schema.parse(input)).toEqual(input);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, machineId: 'another-controller' }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { kind: 'workspace', workspaceId: 'unrelated' } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, cloneSource: true }).success).toBe(false);
  });

  it('binds a native sync destination to its actual installed controller', () => {
    const input = { serverId: 'home', machineId: 'controller',
      source: { kind: 'workspace', workspaceId: 'original', checkout: {
        serverId: 'home', workspaceId: 'original', machineId: 'source', rootPath: '/source' } },
      materialization: { kind: 'sync', targetPath: '/guest/repo',
        targetManaged: { managedId: 'guest', controller: { machineId: 'controller', installationId: 'installed-controller' } },
        workspaceAction: { kind: 'copy_once', contentPolicy: { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [],
          policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] }) } } } };
    expect(OpenProjectInputV1Schema.parse(input)).toEqual(input);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, machineId: 'another-controller' }).success).toBe(false);
  });
  it('returns the native accepted destination without fabricating a guest Machine address', () => {
    const opened = { kind: 'opened', workspace: { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'native-ref',
      managedId: 'guest', controller: { machineId: 'controller', installationId: 'installed-controller' }, rootPath: '/guest/repo' },
      directory: '/guest/repo', setup: 'notRequired' };
    expect(OpenProjectResultV1Schema.parse(opened)).toEqual(opened);
    expect(OpenProjectResultV1Schema.safeParse({ ...opened, workspace: { ...opened.workspace, machineId: 'guest-machine' } }).success).toBe(false);
  });
  it('admits connected clone authentication without accepting credential material', () => {
    const materialization = { kind: 'clone', destinationParentPath: '/workspaces', destinationDirectoryName: 'project',
      initialCheckout: { branch: 'feature/files' }, authentication: 'connected_account',
      gitAccount: { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' } };
    expect(WorkspaceActivationRequestV1Schema.parse(materialization)).toEqual(materialization);
    expect(WorkspaceActivationRequestV1Schema.safeParse({ ...materialization, token: 'private' }).success).toBe(false);
    expect(WorkspaceActivationRequestV1Schema.safeParse({ ...materialization,
      gitAccount: { ...materialization.gitAccount, token: 'private' } }).success).toBe(false);
    expect(WorkspaceActivationRequestV1Schema.safeParse({ ...materialization, authentication: undefined }).success).toBe(false);
  });
  it('carries only the own destination review fact without granting checkout authority', () => {
    const destinationReview = { accountId: 'member', serverId: 'canonical-home', machineId: 'machine',
      destinationParentPath: '/srv/happier/members/own', destinationDirectoryName: 'existing-workspace-id' };
    const refused = { kind: 'refused', code: 'workspace_private_checkout_review_required', destinationReview };
    expect(OpenProjectResultV1Schema.safeParse(refused).success).toBe(true);
    expect(OpenProjectResultV1Schema.safeParse({ ...refused, destinationReview: { ...destinationReview,
      admitted: true } }).success).toBe(false);
    expect(OpenProjectResultV1Schema.safeParse({ ...refused, destinationReview: { ...destinationReview,
      destinationDirectoryName: '../other-member' } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ serverId: 'canonical-home', machineId: 'machine',
      source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' }, destinationReview }).success).toBe(false);
  });

  it('admits the selected folder and existing checkout choices while rejecting caller-minted authority', () => {
    const input = {
      serverId: 'home', machineId: 'machine',
      source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' },
    };
    expect(OpenProjectInputV1Schema.parse(input)).toEqual(input);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, actorAccountId: 'other' }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { ...input.source, admitted: true } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, materialization: { kind: 'attach', runSetup: true } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, subdir: '../outside' }).success).toBe(false);
    const source = { kind: 'source', id: 'source', revision: 1,
      selector: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git', visibility: 'private' }, protocol: 'https' },
    };
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source }).success).toBe(true);
    const checkout = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' };
    expect(OpenProjectInputV1Schema.parse({ ...input, source: { ...source, checkout } }).source).toEqual({ ...source, checkout });
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { ...source, checkout: { ...checkout, admitted: true } } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.parse({ ...input, source: { kind: 'workspace', workspaceId: 'workspace', checkout } }).source)
      .toEqual({ kind: 'workspace', workspaceId: 'workspace', checkout });
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { kind: 'workspace', workspaceId: 'other', checkout } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { ...source, checkout: { ...checkout, serverId: 'other' } } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { ...source, subdir: '../outside' } }).success).toBe(false);
    expect(OpenProjectInputV1Schema.safeParse({ ...input, source: { ...source, selector: { ...source.selector, provider: { ...source.selector.provider, actorAccountId: 'other' } } } }).success).toBe(false);
  });

  it('retains browse acceptance independently of setup approval and omits a fabricated unknown-operation handle', () => {
    const opened = {
      kind: 'opened', workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' },
      directory: '/repo/packages/app', setup: 'approvalRequired',
      facts: { source: { sourceId: 'source', revision: 4 } },
    };
    expect(OpenProjectResultV1Schema.parse(opened)).toEqual(opened);
    expect(OpenProjectResultV1Schema.parse({ kind: 'outcomeUnknown' })).toEqual({ kind: 'outcomeUnknown' });
    expect(OpenProjectResultV1Schema.safeParse({ ...opened, sessionId: 'synthetic' }).success).toBe(false);
    expect(OpenProjectResultV1Schema.safeParse({ ...opened, workspace: { ...opened.workspace, admitted: true } }).success).toBe(false);
  });

  it('keeps source-host acknowledgement distinct from accepted browse identity or setup authority', () => {
    expect(ProjectOpenSyncMaterializationResultV1Schema.parse({ kind: 'materialized' })).toEqual({ kind: 'materialized' });
    expect(ProjectOpenSyncMaterializationResultV1Schema.safeParse({ kind: 'materialized', setup: 'prepared' }).success).toBe(false);
    expect(ProjectOpenSyncMaterializationResultV1Schema.safeParse({ kind: 'outcomeUnknown', operationId: 'invented' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema } from './openProjectV1.js';

describe('OpenProject V1 wire admission', () => {
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

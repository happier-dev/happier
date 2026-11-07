import { describe, expect, it } from 'vitest';

import { readSessionRepositoryV1FromMetadata } from './sessionRepositoryV1';

describe('readSessionRepositoryV1FromMetadata', () => {
  it('accepts older metadata without an association and ignores malformed optional facts', () => {
    for (const value of [undefined, null, {}, { path: '/repo' }, { sessionRepositoryV1: null },
      { sessionRepositoryV1: { v: 2, rootPath: '/repo', worktreePath: '/repo' } },
      { sessionRepositoryV1: { v: 1, rootPath: ' ', worktreePath: '/repo' } },
      { sessionRepositoryV1: { v: 1, rootPath: '/repo', worktreePath: '/repo\0sibling' } }]) {
      expect(readSessionRepositoryV1FromMetadata(value)).toBeNull();
    }
  });

  it('preserves Git path bytes and ignores unrelated metadata', () => {
    const association = { v: 1, machineId: 'host-machine', rootPath: '/repo\n ', worktreePath: '/linked ' };
    expect(readSessionRepositoryV1FromMetadata({ machineId: 'host-machine', path: '/linked /nested', sessionRepositoryV1: association }))
      .toEqual(association);
  });

  it('rejects source-host evidence retained by an older handoff writer at the same target path', () => {
    const association = { v: 1, machineId: 'source', rootPath: '/repo', worktreePath: '/linked' };
    expect(readSessionRepositoryV1FromMetadata({ machineId: 'target', path: '/linked', sessionRepositoryV1: association }))
      .toBeNull();
    expect(readSessionRepositoryV1FromMetadata({ path: '/linked', sessionRepositoryV1: association })).toBeNull();
    expect(readSessionRepositoryV1FromMetadata({ machineId: 'target', sessionRepositoryV1: {
      v: 1, rootPath: '/repo', worktreePath: '/linked',
    } })).toBeNull();
  });
});

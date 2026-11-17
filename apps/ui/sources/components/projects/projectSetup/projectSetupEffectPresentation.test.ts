import { describe, expect, it } from 'vitest';

import { listReviewedSetupCommands, readProjectSetupReviewPresentation } from './projectSetupEffectPresentation';

describe('safe producer setup review presentation', () => {
  it('shows every command covered by lifecycle consent once, keeping command-only reviews scoped', () => {
    const setup = { kind: 'command', command: 'echo setup' };
    const teardown = { kind: 'command', command: 'echo teardown' };
    expect(listReviewedSetupCommands({ purpose: 'setup', commands: [setup], lifecycle: { setup: [setup], teardown: [teardown] } }))
      .toEqual(['echo setup', 'echo teardown']);
    expect(listReviewedSetupCommands({ commands: [teardown] })).toEqual(['echo teardown']);
  });
  it('retains additive committed evidence without changing the legacy fileState or admitting unknown fields', () => {
    const provenance = { file: '.happier/project.json', kind: 'repository', headCommit: 'abc123',
      fileState: 'unknown', committed: { commit: 'abc123', bytes: 'private' } };
    expect(readProjectSetupReviewPresentation({ presentation: { bindings: [], provenance } }))
      .toMatchObject({ provenance: { fileState: 'unknown', committed: { commit: 'abc123' } } });
    expect(readProjectSetupReviewPresentation({ presentation: { bindings: [], provenance } })?.provenance)
      .not.toHaveProperty('committed.bytes');
  });
  it('discloses executable paths and every argument boundary while retaining literal commands verbatim', () => {
    const literal = '  echo "a b" && echo ""  ';
    expect(listReviewedSetupCommands({ commands: [
      { executable: 'C:\\Program Files\\tool.exe', args: ['', 'a b', 'say "hello"', 'tail'] },
      { source: { kind: 'command', command: literal } },
      literal,
    ] })).toEqual(['"C:\\\\Program Files\\\\tool.exe" "" "a b" "say \\"hello\\"" tail', literal, literal]);
  });

  it('reads the literal command DTO emitted by projectSetupPreparation and omits empty or unknown steps', () => {
    // reviewProjectSetupEffect emits literal steps directly, without a nested source.
    expect(listReviewedSetupCommands({ commands: [
      { kind: 'command', command: 'echo setup', cwd: '.', os: 'linux' },
      { source: { kind: 'pluginNative', adapter: { pluginId: 'custom.native', localId: 'task' }, file: 'tasks.json', target: 'bootstrap' } },
      { kind: 'command', command: '  ' }, {}, null,
    ] })).toEqual(['echo setup', 'bootstrap']);
    expect(listReviewedSetupCommands({ commands: [{}] })).toEqual([]);
  });

  it('retains exact binding labels and SCM context while excluding values and extra producer fields', () => {
    const presentation = {
      bindings: [{ name: 'TOKEN', ref: 'saved-secret:deployment', revision: 7, source: 'personal', displayName: 'Deployment account', value: 'private-secret' }],
      provenance: { file: '.happier/project.json', kind: 'repository', headCommit: 'abc123', branch: 'feature', fileState: 'modified', bytes: 'private-file' },
    };
    expect(readProjectSetupReviewPresentation({ presentation, configEnvironment: { TOKEN: 'private-secret' } })).toEqual({
      bindings: [{ name: 'TOKEN', ref: 'saved-secret:deployment', revision: 7, source: 'personal', displayName: 'Deployment account' }],
      provenance: { file: '.happier/project.json', kind: 'repository', headCommit: 'abc123', branch: 'feature', fileState: 'modified' },
    });
  });

  it.each(['nonRepository', 'unavailable'] as const)('preserves %s and unknown file state without inventing repository context', kind => {
    expect(readProjectSetupReviewPresentation({ presentation: { bindings: [], provenance: {
      file: '.happier/project.json', kind, fileState: 'unknown',
    } } })).toEqual({ bindings: [], provenance: { file: '.happier/project.json', kind, fileState: 'unknown' } });
  });

  it('does not derive bindings or provenance from other effect fields when presentation is absent or malformed', () => {
    expect(readProjectSetupReviewPresentation({ bindings: [{ name: 'TOKEN', ref: 'a' }] })).toBeNull();
    expect(readProjectSetupReviewPresentation({ presentation: { bindings: [{ name: 'TOKEN', value: 'secret' }], provenance: {} } })).toBeNull();
  });
});

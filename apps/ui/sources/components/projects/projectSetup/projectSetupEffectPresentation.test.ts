import { describe, expect, it } from 'vitest';

import { readProjectSetupReviewPresentation } from './projectSetupEffectPresentation';

describe('safe producer setup review presentation', () => {
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

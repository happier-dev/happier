import { describe, expect, it } from 'vitest';

import { defaultScmBackendRegistry } from './scmBackendCatalog';

describe('scmBackendCatalog', () => {
  it('rehomes the default SCM backend registry without changing registered backends', () => {
    expect(defaultScmBackendRegistry.listBackends().map((backend) => backend.id)).toEqual(['git', 'sapling']);
  });
});

import { describe, expect, it } from 'vitest';

import { gitlabPipelineToneV1 } from './rowTone.js';

describe('the tone of one GitLab pipeline row', () => {
  it('colours only a failed pipeline: a passed or running one says nothing', () => {
    expect(gitlabPipelineToneV1({ id: '1', status: 'failed' })).toBe('danger');
    expect(gitlabPipelineToneV1({ id: '1', status: 'success' })).toBe('neutral');
    expect(gitlabPipelineToneV1({ id: '1', status: 'running' })).toBe('neutral');
    expect(gitlabPipelineToneV1({ id: '1', status: 'pending' })).toBe('neutral');
    expect(gitlabPipelineToneV1({ id: '1', status: 'canceled' })).toBe('neutral');
  });
});

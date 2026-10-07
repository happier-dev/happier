import type { GitlabProjectedPipelineRowV1 } from '../../triage/detail/projection.js';

/** The tone a Pipelines panel row draws for GitLab's own status of that pipeline. */
export function gitlabPipelineToneV1(row: Pick<GitlabProjectedPipelineRowV1, 'status'>): 'danger' | 'neutral' {
  // Healthy says nothing and running is not a caution: only a failure colours the row.
  return row.status === 'failed' ? 'danger' : 'neutral';
}

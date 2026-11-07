import { describe, expect, it } from 'vitest';
import { parseGithubActionsLocationV1, githubActionsPaneLocationsV1, replaceGithubActionsLocationV1 } from './model.js';

describe('Actions settled location binding', () => {
  it('parses presentation suffixes only after exact domain identities', () => {
    expect(parseGithubActionsLocationV1('runs/81/attempts/2/jobs/91/page')).toEqual({ kind: 'run', runId: '81', attempt: '2', jobId: '91', presentation: 'page' });
    expect(parseGithubActionsLocationV1('workflows/12/page')).toEqual({ kind: 'workflow', workflowId: '12', presentation: 'page' });
    expect(parseGithubActionsLocationV1('runs/81/page/attempts/2')).toBeNull();
    expect(parseGithubActionsLocationV1('runs/81/attempts/0')).toBeNull();
    expect(githubActionsPaneLocationsV1('runs/81/attempts/2/jobs/91')).toEqual({ fullPageLocation: { subPath: 'runs/81/attempts/2/jobs/91/page', backLocation: 'runs/81/attempts/2/jobs/91' }, returnLocation: { subPath: 'runs/81/attempts/2/jobs/91', backLocation: 'runs' } });
  });
  it('renders the returned settled path and preserves the prior selection on refusal or invalid settlement', async () => {
    const previous = parseGithubActionsLocationV1('runs/81/attempts/2/jobs/91')!;
    const locations = githubActionsPaneLocationsV1('runs/81/attempts/2/jobs/91')!;
    const calls: unknown[] = [];
    const host = { replacePageLocation: async (subPath: string, options: unknown) => { calls.push([subPath, options]); return { subPath: 'runs/81/attempts/2/page' }; } };
    const changed = await replaceGithubActionsLocationV1(host, locations.fullPageLocation, previous);
    expect(changed).toMatchObject({ kind: 'applied', location: { runId: '81', attempt: '2', presentation: 'page' } });
    expect(calls).toEqual([[locations.fullPageLocation.subPath, { backLocation: locations.fullPageLocation.backLocation }]]);
    expect(await replaceGithubActionsLocationV1({ replacePageLocation: async () => ({ subPath: 'garbage' }) }, locations.fullPageLocation, previous)).toEqual({ kind: 'unavailable', location: previous });
    expect(await replaceGithubActionsLocationV1({ replacePageLocation: async () => { throw new Error('refused'); } }, locations.fullPageLocation, previous)).toEqual({ kind: 'unavailable', location: previous });
  });
});

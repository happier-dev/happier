import { expect, it } from 'vitest';
import { ScmHostingPullRequestLifecycleV1Schema } from './pullRequestLifecycleV1.js';

it('retains opaque provider author identities without inventing a login', () => {
    const occurrence = { id: '42', number: 42, action: 'opened', headSha: 'a'.repeat(40), headRef: 'feature', baseRef: 'main',
        baseRepository: { kind: 'bitbucket', deployment: 'https://bitbucket.org', repository: 'team/repo' }, headRepository: null,
        author: { id: '{12345678-1234-1234-1234-123456789012}', login: null, kind: 'unsupported' } };
    expect(ScmHostingPullRequestLifecycleV1Schema.parse(occurrence)).toEqual({ ...occurrence, authorAssociation: 'unknown' });
    expect(ScmHostingPullRequestLifecycleV1Schema.parse({ ...occurrence, author: { id: '123', login: 'octocat', kind: 'human' } }).author.login).toBe('octocat');
    expect(ScmHostingPullRequestLifecycleV1Schema.safeParse({ ...occurrence, author: { ...occurrence.author, id: '' } }).success).toBe(false);
});

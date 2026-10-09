import { describe, expect, it } from 'vitest';
import { ProjectSourceRepositorySelectorV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { describeProjectSourceRow, formatProjectSourceAddress } from './projectSourceAddress';

describe('Source address presentation', () => {
    it.each([undefined, '.', './', ''])('describes whole-repository selections consistently (%j)', subdir => {
        const repository = ProjectSourceRepositorySelectorV1Schema.parse({
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'group/repo' }, protocol: 'https',
        });
        expect(describeProjectSourceRow({ repository, subdir }, 'Whole repository')).toBe('group/repo · Whole repository');
    });
    it('shows the canonical deployment path and repository identity without transport authoring', () => {
        const repository = ProjectSourceRepositorySelectorV1Schema.parse({
            provider: { id: 'installed-forge/gitlab', kind: 'gitlab', displayName: 'Company GitLab', baseUrl: 'http://forge:8080/gitlab/' },
            repository: { nameWithOwner: 'group/repo' }, protocol: 'ssh',
        });
        expect(formatProjectSourceAddress(repository)).toBe('forge:8080/gitlab/group/repo');
        expect(describeProjectSourceRow({ repository, defaultRef: 'v0.3', subdir: 'apps/ios' })).toBe('group/repo · v0.3 · apps/ios');
    });
});

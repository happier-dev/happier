import { describe, expect, it } from 'vitest';
import { ProjectSourceRepositorySelectorV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { describeProjectSourceRow, formatProjectSourceAddress } from './projectSourceAddress';

describe('Source address presentation', () => {
    it('names a repository-less Source without inventing repository, ref or folder facts', () => {
        expect(describeProjectSourceRow({ name: 'Production', defaultRef: 'old-main', subdir: 'old-folder' })).toBe('Production');
    });
    // A list row speaks only what tells Sources apart: the whole repository is the quiet default (lab p-sources LIST,
    // "happier-dev/happier · v0.3"); a folder is named only when one is chosen.
    it.each([undefined, '.', './', ''])('leaves a whole-repository selection unsaid in a row (%j)', subdir => {
        const repository = ProjectSourceRepositorySelectorV1Schema.parse({
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'group/repo' }, protocol: 'https',
        });
        expect(describeProjectSourceRow({ repository, subdir })).toBe('group/repo');
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

import { describe, expect, it } from 'vitest';

import { parseGitPatchDiffStats } from './diffStats';

describe('parseGitPatchDiffStats', () => {
    it('counts added/removed lines per file in git-style patches', () => {
        const diff = [
            'diff --git a/foo.txt b/foo.txt',
            'index 123..456 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,2 +1,2 @@',
            '-old',
            '+new',
            ' unchanged',
            'diff --git a/new.txt b/new.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/new.txt',
            '@@ -0,0 +1,2 @@',
            '+hello',
            '+world',
            'diff --git a/bin.dat b/bin.dat',
            'GIT binary patch',
            'literal 0',
            'HcmV?d00001',
            '',
        ].join('\n');

        const stats = parseGitPatchDiffStats(diff);

        expect(stats.get('foo.txt')).toEqual({ pendingAdded: 1, pendingRemoved: 1, isBinary: false });
        expect(stats.get('new.txt')).toEqual({ pendingAdded: 2, pendingRemoved: 0, isBinary: false });
        expect(stats.get('bin.dat')).toEqual({ pendingAdded: 0, pendingRemoved: 0, isBinary: true });
    });
});


import { describe, expect, it } from 'vitest';

import { formatPathRelativeToHome, formatSessionPath, readSessionPathName } from './formatPathRelativeToHome';

// The linuxUsersV1 layout a separated member receives: home and workspace are separate roots.
const MEMBER_DIGEST = '770cf64d44d259c85fd16505c1947428cd90e2221cf85cb580f86b68cc34fb1d';
const MEMBER_WORKSPACE = `/srv/happier/members/${MEMBER_DIGEST}`;
const MEMBER_HOME = `/var/lib/happier/members/${MEMBER_DIGEST}`;

describe('formatPathRelativeToHome', () => {
    it('can name the home root without replacing relative folders or the default abbreviation', () => {
        const presentation = { homeLabel: 'Home folder' };
        expect(formatPathRelativeToHome('/home/alice/', '/home/alice', presentation)).toBe('Home folder');
        expect(formatPathRelativeToHome('C:\\Users\\alice\\', 'C:/Users/alice', presentation)).toBe('Home folder');
        for (const alias of ['~', '~/', '~\\']) {
            expect(formatPathRelativeToHome(alias, undefined, presentation)).toBe('Home folder');
        }
        expect(formatPathRelativeToHome('/home/alice/repo', '/home/alice', presentation)).toBe('~/repo');
        expect(formatPathRelativeToHome('/home/alice2', '/home/alice', presentation)).toBe('/home/alice2');
        expect(formatPathRelativeToHome('/home/alice', undefined, presentation)).toBe('/home/alice');
        expect(formatPathRelativeToHome(MEMBER_WORKSPACE, MEMBER_HOME, presentation)).toBe('Your workspace');
    });
    it('normalizes home-relative separator aliases through the canonical expansion owner', () => {
        expect(formatPathRelativeToHome('~\\repo/mixed\\path', 'C:\\Users\\alice\\\\')).toBe('~/repo/mixed/path');
        expect(formatPathRelativeToHome('~/', '/home/alice///')).toBe('~');
    });
    it('formats a POSIX path below home and preserves a sibling-prefix path', () => {
        expect(formatPathRelativeToHome('/Users/alice/projects/demo', '/Users/alice')).toBe('~/projects/demo');
        expect(formatPathRelativeToHome('/Users/alice2/projects/demo', '/Users/alice')).toBe('/Users/alice2/projects/demo');
    });

    it('formats a Windows home path as ~/ with normalized separators', () => {
        expect(formatPathRelativeToHome('C:/Users\\alice/projects\\demo', 'C:\\Users\\alice')).toBe('~/projects/demo');
    });

    it('formats the Windows home directory itself as ~ even when the path has a trailing separator', () => {
        expect(formatPathRelativeToHome('C:\\Users\\alice\\', 'C:\\Users\\alice')).toBe('~');
    });

    it('leaves non-home Windows paths unchanged', () => {
        expect(formatPathRelativeToHome('D:\\work\\demo', 'C:\\Users\\alice')).toBe('D:\\work\\demo');
    });

    it('preserves a Windows sibling-prefix path while normalizing mixed separators below home', () => {
        expect(formatPathRelativeToHome('C:\\Users\\alice2\\projects\\demo', 'C:\\Users\\alice')).toBe('C:\\Users\\alice2\\projects\\demo');
        expect(formatPathRelativeToHome('C:\\Users/alice\\projects/demo', 'C:/Users\\alice')).toBe('~/projects/demo');
    });
});

describe('formatSessionPath', () => {
    it('shows the machine home and literal home aliases as ~, never as the managed "No folder" label', () => {
        expect(formatSessionPath('~\\', 'C:\\Users\\alice\\\\')).toBe('~');
        expect(formatSessionPath('/home/alice/', '/home/alice')).toBe('~');
        for (const alias of ['~', '~/', '~\\']) {
            expect(formatSessionPath(alias, undefined)).toBe('~');
        }
        expect(formatSessionPath('~/', '')).toBe('~');
    });

    it('keeps folders below home relative and generic filesystem labels intact', () => {
        expect(formatSessionPath('/home/alice/repo', '/home/alice')).toBe('~/repo');
        expect(formatSessionPath('C:\\Users\\alice2', 'C:\\Users\\alice')).toBe('C:\\Users\\alice2');
        expect(formatSessionPath('/home/alice', undefined)).toBe('/home/alice');
    });
});

describe('member workspace display', () => {
    it('names a separated member\'s workspace root by a plain name and keeps subpaths relative to it', () => {
        expect(formatSessionPath(MEMBER_WORKSPACE, MEMBER_HOME)).toBe('Your workspace');
        expect(formatSessionPath(`${MEMBER_WORKSPACE}/`, MEMBER_HOME)).toBe('Your workspace');
        expect(formatSessionPath(`${MEMBER_WORKSPACE}/api/src`, MEMBER_HOME)).toBe('Your workspace/api/src');
        expect(formatPathRelativeToHome(`${MEMBER_WORKSPACE}/api`, undefined)).toBe('Your workspace/api');
    });

    it('leaves paths that only resemble the layout untouched', () => {
        expect(formatSessionPath('/srv/happier/members/not-a-digest/api', MEMBER_HOME)).toBe('/srv/happier/members/not-a-digest/api');
        expect(formatSessionPath(`/srv/happier/members/${MEMBER_DIGEST}x`, MEMBER_HOME)).toBe(`/srv/happier/members/${MEMBER_DIGEST}x`);
    });

    it('reads a separated member\'s own home as home, never by its digest', () => {
        const hostHome = '/home/happier.guest';
        expect(formatSessionPath(MEMBER_HOME, hostHome)).toBe('~');
        expect(formatSessionPath(`${MEMBER_HOME}/`, hostHome)).toBe('~');
        expect(formatSessionPath(`${MEMBER_HOME}/api/src`, undefined)).toBe('~/api/src');
        expect(formatPathRelativeToHome(MEMBER_HOME, undefined, { homeLabel: 'Home folder' })).toBe('Home folder');
        expect(readSessionPathName(MEMBER_HOME)).toBe('Home folder');
        expect(readSessionPathName(`${MEMBER_HOME}/api`)).toBe('api');
        expect(formatSessionPath(`/var/lib/happier/members/${MEMBER_DIGEST}x`, hostHome)).toBe(`/var/lib/happier/members/${MEMBER_DIGEST}x`);
    });

    it('names a Session at the member workspace root by the workspace, never by its digest', () => {
        expect(readSessionPathName(MEMBER_WORKSPACE)).toBe('Your workspace');
        expect(readSessionPathName(`${MEMBER_WORKSPACE}/api`)).toBe('api');
        expect(readSessionPathName('/home/alice/repo/')).toBe('repo');
        expect(readSessionPathName('/')).toBeNull();
    });
});

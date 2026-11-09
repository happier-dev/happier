import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
    return readdirSync(root).flatMap((entry) => {
        const path = join(root, entry);
        return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
    });
}

// Local rendering already feeds read state and notification suppression through
// `sessionSurfaceVisibility`, so a remote observation flowing back into those owners
// would silently mark Sessions read or suppress alerts for people who only appeared
// in someone else's facepile. Presence is display-only in both directions.
const FORBIDDEN_ATTENTION_OWNERS = [
    '@/sync/domains/session/readState',
    '@/sync/domains/session/readCursor',
    '@/sync/domains/session/attention',
    '@/sync/domains/session/awareness',
    '@/sync/domains/session/changes',
    'sessionFollow',
    'SessionFollow',
    'markSessionRead',
    'lastViewedSessionSeq',
    'notification',
    'Notification',
    'badge',
    'Badge',
];
const uiRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('human presence attention boundary', () => {
    it.each([
        'sources/sync/domains/session/humanPresence',
        'sources/components/sessions/collaboration',
    ])('keeps %s free of read, Follow, attention and notification owners', (directory) => {
        const files = sourceFiles(join(uiRoot, directory))
            .filter((path) => !/\.(test|spec)\.tsx?$/.test(path))
            // The access editor and public-link sections are separate Session-access
            // owners that legitimately reach other domains; presence is the boundary here.
            .filter((path) => /humanPresence|SessionPresence|SessionViewerFacepile/.test(path));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const imports = readFileSync(file, 'utf8')
                .split('\n')
                .filter((line) => /^\s*import\b/.test(line))
                .join('\n');
            for (const owner of FORBIDDEN_ATTENTION_OWNERS) {
                expect(imports, `${file} must not import ${owner}`).not.toContain(owner);
            }
        }
    });

    it('reads rendered surfaces from the one visibility owner and never writes them back', () => {
        const runtime = readFileSync(
            join(uiRoot, 'sources/sync/domains/session/humanPresence/sessionHumanPresenceRuntime.ts'),
            'utf8',
        );
        expect(runtime).toContain('getVisibleSessionSurfaces');
        // A remote observation must never become a local "this surface is rendered" fact.
        expect(runtime).not.toContain('markSessionSurfaceVisible');
        expect(runtime).not.toContain('markSessionSurfaceHidden');
    });
});

import { it, vi } from 'vitest';
import { runMemberInstallJourney } from './memberInstallJourney.composed.testkit';

// Writable wrappers replace only native system boundaries; all admission and
// install owners keep their real implementations.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Home shutdown is process-scoped, so each enrollment scenario owns its file.
it.skipIf(process.platform !== 'linux')('Acquire continues through member install and Cancel when enrollment roles are unavailable', () => runMemberInstallJourney(false), 300_000);

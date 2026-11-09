import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    HAPPIER_DESKTOP_PATH_MARKER_LINE,
    HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE,
    HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
    ensureHappierCliPathExposure,
    planWindowsUserPathExposure,
    planWindowsUserPathRemoval,
    removeHappierCliPathExposure,
    renderHappierCliPathExportLine,
    resolveHappierCliShellProfilePlan,
} from './ensureHappierCliPathExposure.js';
import { writeHappierCliChoice } from './happierCliChoice.js';

// Spawning powershell.exe is a genuine OS boundary, and this host has no PowerShell; the mock
// records the argv/env the writer builds and answers the callback. Everything under it — the
// snapshot parse, the PATH plan, the script text — stays real.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const tempDirs: string[] = [];

async function createHome(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-path-exposure-'));
    tempDirs.push(homeDir);
    return homeDir;
}

async function readOptional(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return null;
    }
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
    }));
});

async function readInstallerExportLineTemplate(): Promise<string> {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const installScriptPath = resolve(testDir, '..', '..', '..', '..', 'apps', 'website', 'public', 'install.sh');
    const installScript = await readFile(installScriptPath, 'utf8');
    const match = /^\s*local export_line="(?<template>export PATH=.*)"$/mu.exec(installScript);
    if (!match?.groups?.template) {
        throw new Error(`install.sh export_line template not found in ${installScriptPath}`);
    }
    // Undo bash double-quote escaping: \" -> " and \$ -> $.
    return match.groups.template.replace(/\\(["$])/gu, '$1');
}

posixOnly('ensureHappierCliPathExposure (POSIX shell profiles)', () => {
    it('emits the byte-identical export line the shell installer writes', async () => {
        const template = await readInstallerExportLineTemplate();
        const binDir = '/Users/example/.happier/bin';

        expect(template).toContain('${BIN_DIR}');
        expect(renderHappierCliPathExportLine(binDir)).toBe(template.replace('${BIN_DIR}', binDir));
    });

    it('appends the marked export line once and treats a second call as a no-op', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh' };
        const zshrcPath = join(homeDir, '.zshrc');
        await writeFile(zshrcPath, 'alias ll="ls -l"\n', 'utf8');

        const first = await ensureHappierCliPathExposure({ binDir, processEnv });
        expect(first).toEqual({
            changed: true,
            shellReloadHint: expect.stringContaining(zshrcPath),
            failure: null, existingCommand: null,
        });

        const expectedLine = renderHappierCliPathExportLine(binDir);
        const afterFirst = await readFile(zshrcPath, 'utf8');
        expect(afterFirst).toBe(`alias ll="ls -l"\n\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${expectedLine}\n`);
        expect(await readFile(join(homeDir, '.zprofile'), 'utf8')).toBe(`\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${expectedLine}\n`);

        const second = await ensureHappierCliPathExposure({ binDir, processEnv });
        expect(second).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: null });
        expect(await readFile(zshrcPath, 'utf8')).toBe(afterFirst);
    });

    it('neither marks nor removes a pre-existing installer-owned line', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh' };
        const installerOwned = `# shell installer\n\n${renderHappierCliPathExportLine(binDir)}\nalias ll="ls -l"\n`;
        await writeFile(join(homeDir, '.zshrc'), installerOwned, 'utf8');
        await writeFile(join(homeDir, '.zprofile'), installerOwned, 'utf8');

        const ensured = await ensureHappierCliPathExposure({ binDir, processEnv });
        expect(ensured).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: null });
        expect(await readFile(join(homeDir, '.zshrc'), 'utf8')).toBe(installerOwned);

        const removed = await removeHappierCliPathExposure({ processEnv });
        expect(removed).toEqual({ removed: false, failure: null });
        expect(await readFile(join(homeDir, '.zshrc'), 'utf8')).toBe(installerOwned);
        expect(await readFile(join(homeDir, '.zprofile'), 'utf8')).toBe(installerOwned);
    });

    it('removes only Desktop-created entries and leaves everything else byte-identical', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const processEnv = { HOME: homeDir, SHELL: '/bin/bash' };
        const bashrcOriginal = 'export EDITOR=vim\n# comment\nalias ll="ls -l"\n';
        const profileOriginal = `# installer-owned\n\n${renderHappierCliPathExportLine(binDir)}\n`;
        await writeFile(join(homeDir, '.bashrc'), bashrcOriginal, 'utf8');
        await writeFile(join(homeDir, '.profile'), profileOriginal, 'utf8');

        await ensureHappierCliPathExposure({ binDir, processEnv });
        expect(await readFile(join(homeDir, '.bashrc'), 'utf8')).not.toBe(bashrcOriginal);
        expect(await readFile(join(homeDir, '.profile'), 'utf8')).toBe(profileOriginal);

        const removed = await removeHappierCliPathExposure({ processEnv });
        expect(removed).toEqual({ removed: true, failure: null });
        expect(await readFile(join(homeDir, '.bashrc'), 'utf8')).toBe(bashrcOriginal);
        expect(await readFile(join(homeDir, '.profile'), 'utf8')).toBe(profileOriginal);

        const removedAgain = await removeHappierCliPathExposure({ processEnv });
        expect(removedAgain).toEqual({ removed: false, failure: null });
    });

    it('scopes removal to one bin directory while preserving other Desktop and user profile entries', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const otherBinDir = join(homeDir, '.happier-other', 'bin');
        const marked = (dir: string) => `\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${renderHappierCliPathExportLine(dir)}\n`;
        const retained = `# user settings\n${renderHappierCliPathExportLine(binDir)}\n${marked(otherBinDir)}\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${renderHappierCliPathExportLine(binDir)} # user edited\n`;
        const profilePath = join(homeDir, '.zprofile');
        await writeFile(profilePath, retained + marked(binDir), 'utf8');
        const params = { binDir, processEnv: { HOME: homeDir, SHELL: '/bin/bash' } };

        expect(await removeHappierCliPathExposure(params)).toEqual({ removed: true, failure: null });
        expect(await readFile(profilePath, 'utf8')).toBe(retained);
        expect(await removeHappierCliPathExposure(params)).toEqual({ removed: false, failure: null });
        expect(await readFile(profilePath, 'utf8')).toBe(retained);
    });

    it('removes profiles written under a previous shell and keeps an unmarked identical line', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const exportLine = renderHappierCliPathExportLine(binDir);
        // Desktop exposed the CLI while the login shell was zsh.
        await ensureHappierCliPathExposure({ binDir, processEnv: { HOME: homeDir, SHELL: '/bin/zsh' } });
        // The user then switched to bash and hand-wrote the same export themselves (no marker).
        await writeFile(join(homeDir, '.bashrc'), `${exportLine}\n`, 'utf8');

        const removed = await removeHappierCliPathExposure({ processEnv: { HOME: homeDir, SHELL: '/bin/bash' } });

        expect(removed).toEqual({ removed: true, failure: null });
        expect(await readFile(join(homeDir, '.zshrc'), 'utf8')).toBe('');
        expect(await readFile(join(homeDir, '.zprofile'), 'utf8')).toBe('');
        expect(await readFile(join(homeDir, '.bashrc'), 'utf8')).toBe(`${exportLine}\n`);
    });

    it('leaves PATH alone when another happier already resolves, and names it', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const userBinDir = join(homeDir, 'npm-global', 'bin');
        await mkdir(userBinDir, { recursive: true });
        const userHappier = join(userBinDir, 'happier');
        await writeFile(userHappier, '#!/bin/sh\n', 'utf8');
        await chmod(userHappier, 0o755);
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', PATH: `/usr/bin:${userBinDir}` };

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: userHappier });
        expect(await readOptional(join(homeDir, '.zshrc'))).toBeNull();
    });

    it('puts the managed CLI first even though another happier resolves, once this computer chose "Let Happier manage it" (R12/INV5)', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const userBinDir = join(homeDir, 'npm-global', 'bin');
        await mkdir(userBinDir, { recursive: true });
        const userHappier = join(userBinDir, 'happier');
        await writeFile(userHappier, '#!/bin/sh\n', 'utf8');
        await chmod(userHappier, 0o755);
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', PATH: `/usr/bin:${userBinDir}` };
        await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result).toEqual({
            changed: true,
            shellReloadHint: expect.stringContaining(join(homeDir, '.zshrc')),
            failure: null,
            existingCommand: userHappier,
        });
        expect(await readFile(join(homeDir, '.zshrc'), 'utf8'))
            .toBe(`\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${renderHappierCliPathExportLine(binDir)}\n`);
    });

    it('writes no line once this computer chose "Keep my own" (R12/INV5)', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const userBinDir = join(homeDir, 'npm-global', 'bin');
        await mkdir(userBinDir, { recursive: true });
        const userHappier = join(userBinDir, 'happier');
        await writeFile(userHappier, '#!/bin/sh\n', 'utf8');
        await chmod(userHappier, 0o755);
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', PATH: '/usr/bin' };
        await writeHappierCliChoice({ choice: { mode: 'own', command: userHappier }, processEnv });

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: userHappier });
        expect(await readOptional(join(homeDir, '.zshrc'))).toBeNull();
        expect(await readOptional(join(homeDir, '.zprofile'))).toBeNull();
    });

    it('on macOS also finds a happier in the standard locations a GUI app\'s launchd PATH leaves out (INV5)', async () => {
        const realPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        try {
            const homeDir = await createHome();
            const binDir = join(homeDir, '.happier', 'bin');
            // A CLI the user installed into the per-user bin the service PATH owner lists.
            const userBinDir = join(homeDir, '.local', 'bin');
            await mkdir(userBinDir, { recursive: true });
            const userHappier = join(userBinDir, 'happier');
            await writeFile(userHappier, '#!/bin/sh\n', 'utf8');
            await chmod(userHappier, 0o755);
            // What launchd gives an app opened from the Dock or Finder.
            const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

            const result = await ensureHappierCliPathExposure({ binDir, processEnv });

            expect(result).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: userHappier });
            expect(await readOptional(join(homeDir, '.zshrc'))).toBeNull();
        } finally {
            Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
        }
    });

    it('adds nothing when the happier on PATH already is the managed shim (installer ~/.local/bin link)', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const versionDir = join(homeDir, '.happier', 'cli', 'versions', '1.0.0');
        await mkdir(versionDir, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFile(join(versionDir, 'happier'), '#!/bin/sh\n', 'utf8');
        await chmod(join(versionDir, 'happier'), 0o755);
        await symlink(join(versionDir, 'happier'), join(binDir, 'happier'));
        const localBin = join(homeDir, '.local', 'bin');
        await mkdir(localBin, { recursive: true });
        await symlink(join(binDir, 'happier'), join(localBin, 'happier'));
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', PATH: `${localBin}:/usr/bin` };

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: null });
        expect(await readOptional(join(homeDir, '.zshrc'))).toBeNull();
    });

    it('honours HAPPIER_NO_PATH_UPDATE=1 without writing anything', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', HAPPIER_NO_PATH_UPDATE: '1' };

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result).toEqual({ changed: false, shellReloadHint: null, failure: null, existingCommand: null });
        expect(await readOptional(join(homeDir, '.zshrc'))).toBeNull();
        expect(await readOptional(join(homeDir, '.zprofile'))).toBeNull();
    });

    it('reports a read-only profile as a quiet failure instead of throwing', async () => {
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            return;
        }
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const processEnv = { HOME: homeDir, SHELL: '/bin/fish' };
        const profilePath = join(homeDir, '.profile');
        const original = '# locked down\n';
        await writeFile(profilePath, original, 'utf8');
        await chmod(profilePath, 0o444);
        try {
            const result = await ensureHappierCliPathExposure({ binDir, processEnv });

            expect(result.changed).toBe(false);
            expect(result.shellReloadHint).toBeNull();
            expect(result.failure).toEqual(expect.stringContaining(profilePath));
            expect(await readFile(profilePath, 'utf8')).toBe(original);
        } finally {
            await chmod(profilePath, 0o644);
        }
    });

    it('selects rc files per shell exactly like the shell installer', async () => {
        const homeDir = await createHome();
        const noFile = () => false;
        const bashProfileExists = (path: string) => path === join(homeDir, '.bash_profile');

        expect(resolveHappierCliShellProfilePlan({ shell: '/bin/zsh', homeDir, fileExists: noFile })).toEqual({
            rcFiles: [join(homeDir, '.zshrc'), join(homeDir, '.zprofile')],
            reloadFile: join(homeDir, '.zshrc'),
        });
        expect(resolveHappierCliShellProfilePlan({ shell: '/usr/local/bin/bash', homeDir, fileExists: noFile })).toEqual({
            rcFiles: [join(homeDir, '.bashrc'), join(homeDir, '.profile')],
            reloadFile: join(homeDir, '.bashrc'),
        });
        expect(resolveHappierCliShellProfilePlan({ shell: '/bin/bash', homeDir, fileExists: bashProfileExists })).toEqual({
            rcFiles: [join(homeDir, '.bashrc'), join(homeDir, '.bash_profile')],
            reloadFile: join(homeDir, '.bashrc'),
        });
        expect(resolveHappierCliShellProfilePlan({ shell: '/usr/bin/fish', homeDir, fileExists: noFile })).toEqual({
            rcFiles: [join(homeDir, '.profile')],
            reloadFile: join(homeDir, '.profile'),
        });
        expect(resolveHappierCliShellProfilePlan({ shell: undefined, homeDir, fileExists: noFile })).toEqual({
            rcFiles: [join(homeDir, '.profile')],
            reloadFile: join(homeDir, '.profile'),
        });
    });

    it('creates a missing rc file the same way the installer does', async () => {
        const homeDir = await createHome();
        const binDir = join(homeDir, '.happier', 'bin');
        const processEnv = { HOME: homeDir, SHELL: '/usr/bin/fish' };

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result.changed).toBe(true);
        expect((await stat(join(homeDir, '.profile'))).isFile()).toBe(true);
        expect(await readFile(join(homeDir, '.profile'), 'utf8')).toBe(
            `\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${renderHappierCliPathExportLine(binDir)}\n`,
        );
    });
});

describe('Windows user PATH exposure planning', () => {
    const binDir = 'C:\\Users\\example\\.happier\\bin';
    const npmDir = 'C:\\Users\\example\\AppData\\Roaming\\npm';

    it('scopes Desktop-created removal and retains other homes and their provenance verbatim', () => {
        const otherDir = 'C:\\Other Home\\bin';
        const remainingProvenance = ` ${otherDir} `;
        const remainingMove = ` ${otherDir}|C:\\Tools `;
        expect(planWindowsUserPathRemoval({
            binDir,
            userPath: `${binDir};${otherDir};C:\\Tools`,
            provenance: `${binDir.toUpperCase()};${remainingProvenance}`,
            moves: `${binDir}|C:\\Tools;${remainingMove}`,
        })).toEqual({ removed: true, userPath: `${otherDir};C:\\Tools`, provenance: remainingProvenance, moves: remainingMove });
    });

    it('undoes only the selected move without removing or reordering another home', () => {
        const otherDir = 'C:\\Other Home\\bin';
        expect(planWindowsUserPathRemoval({
            binDir,
            userPath: `${binDir};${otherDir};C:\\Tools`,
            provenance: otherDir,
            moves: `${binDir.toUpperCase()}|C:\\Tools;${otherDir}|C:\\Tools`,
        })).toEqual({ removed: true, userPath: `${otherDir};C:\\Tools;${binDir}`, provenance: otherDir, moves: `${otherDir}|C:\\Tools` });
    });

    it('leaves unrelated records untouched when the selected home has no exposure', () => {
        const otherDir = 'C:\\Other Home\\bin';
        const current = { userPath: `${otherDir};C:\\Tools`, provenance: otherDir, moves: `${otherDir}|C:\\Tools` };
        expect(planWindowsUserPathRemoval({ ...current, binDir })).toEqual({ removed: false, ...current });
    });

    it('prepends the bin dir once and records it as Desktop-created', () => {
        const first = planWindowsUserPathExposure({
            userPath: 'C:\\Tools;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps',
            provenance: null,
            moves: null,
            binDir,
        });
        expect(first).toEqual({
            changed: true,
            userPath: `${binDir};C:\\Tools;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps`,
            provenance: binDir,
            moves: null,
        });

        const second = planWindowsUserPathExposure({
            userPath: first.userPath,
            provenance: first.provenance,
            moves: first.moves,
            binDir,
        });
        expect(second).toEqual({ changed: false, userPath: first.userPath, provenance: first.provenance, moves: null });
    });

    it('after "Let Happier manage it" moves an entry that sits behind npm to the front, once, recording the move without claiming the entry (R12/R13)', () => {
        // The installer added the managed dir earlier; npm's global dir now precedes it.
        const behindNpm = `${npmDir};C:\\Tools;${binDir.toUpperCase()}`;

        const moved = planWindowsUserPathExposure({ userPath: behindNpm, provenance: null, moves: null, binDir, putFirst: true });
        expect(moved).toEqual({
            changed: true,
            userPath: `${binDir.toUpperCase()};${npmDir};C:\\Tools`,
            provenance: null,
            moves: `${binDir.toUpperCase()}|${npmDir}|C:\\Tools`,
        });
        // Already first: nothing to do.
        expect(planWindowsUserPathExposure({ userPath: moved.userPath, provenance: null, moves: moved.moves, binDir, putFirst: true }))
            .toEqual({ changed: false, userPath: moved.userPath, provenance: null, moves: moved.moves });
        // Without that answer an entry that is present anywhere is left where it is.
        expect(planWindowsUserPathExposure({ userPath: behindNpm, provenance: null, moves: null, binDir }).changed).toBe(false);
    });

    it('"Keep my own" puts a moved entry back behind what it was moved ahead of, keeping later user edits (R13)', () => {
        const behindNpm = `${npmDir};C:\\Tools;${binDir}`;
        const moved = planWindowsUserPathExposure({ userPath: behindNpm, provenance: null, moves: null, binDir, putFirst: true });

        // Round trip: the terminal gets npm's happier first again, and the record is gone.
        expect(planWindowsUserPathRemoval({ userPath: moved.userPath, provenance: null, moves: moved.moves }))
            .toEqual({ removed: true, userPath: behindNpm, provenance: null, moves: null });

        // An entry the person added since stays where they put it.
        expect(planWindowsUserPathRemoval({ userPath: `C:\\Mine;${moved.userPath}`, provenance: null, moves: moved.moves }))
            .toEqual({ removed: true, userPath: `C:\\Mine;${behindNpm}`, provenance: null, moves: null });

        // The person already put it behind npm themselves: the move no longer holds, nothing is
        // reordered, and the stale record is dropped.
        const userReordered = `${npmDir};${binDir};C:\\Tools`;
        expect(planWindowsUserPathRemoval({ userPath: userReordered, provenance: null, moves: moved.moves }))
            .toEqual({ removed: false, userPath: userReordered, provenance: null, moves: null });

        // An entry Desktop wrote itself is removed outright, moved or not.
        const desktopWritten = planWindowsUserPathExposure({ userPath: `${npmDir};${binDir}`, provenance: binDir, moves: null, binDir, putFirst: true });
        expect(planWindowsUserPathRemoval({ userPath: desktopWritten.userPath, provenance: binDir, moves: desktopWritten.moves }))
            .toEqual({ removed: true, userPath: npmDir, provenance: null, moves: null });
    });

    it('does not claim an entry the PowerShell installer already added', () => {
        const installerOwned = `${binDir.toUpperCase()};C:\\Tools`;
        const planned = planWindowsUserPathExposure({ userPath: installerOwned, provenance: null, moves: null, binDir });
        expect(planned).toEqual({ changed: false, userPath: installerOwned, provenance: null, moves: null });

        const removal = planWindowsUserPathRemoval({ userPath: installerOwned, provenance: null, moves: null });
        expect(removal).toEqual({ removed: false, userPath: installerOwned, provenance: null, moves: null });
    });

    it('removes only the Desktop-created entry and preserves every other entry verbatim', () => {
        const userPath = `${binDir};C:\\Tools;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps`;
        const removal = planWindowsUserPathRemoval({ userPath, provenance: binDir, moves: null });
        expect(removal).toEqual({
            removed: true,
            userPath: 'C:\\Tools;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps',
            provenance: null,
            moves: null,
        });
    });
});

describe('Windows user PATH transport', () => {
    // `execFile` is overloaded; this narrows the mock to the one signature the writer calls.
    const execFileMock = vi.mocked(execFile as unknown as (
        command: string,
        args: readonly string[],
        options: Readonly<{ env?: NodeJS.ProcessEnv }>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => void);
    const realPlatform = process.platform;

    function setPlatform(value: string): void {
        Object.defineProperty(process, 'platform', { value, configurable: true });
    }

    afterEach(() => {
        setPlatform(realPlatform);
        execFileMock.mockReset();
    });

    it('passes a scoped removal through the real plan and keeps unrelated records in the write', async () => {
        setPlatform('win32');
        const binDir = 'C:\\Users\\example\\.happier\\bin';
        const otherDir = 'C:\\Other Home\\bin';
        execFileMock.mockImplementation((_command, _args, _options, callback) => {
            callback(null, execFileMock.mock.calls.length === 1 ? JSON.stringify({
                userPath: `${binDir};${otherDir};C:\\Tools`, userPathKind: 'ExpandString',
                provenance: `${binDir};${otherDir}`, moves: `${otherDir}|C:\\Tools`,
            }) : '', '');
        });
        expect(await removeHappierCliPathExposure({ binDir, processEnv: { SystemRoot: 'C:\\Windows' } }))
            .toEqual({ removed: true, failure: null });
        expect(execFileMock.mock.calls[1]?.[2].env).toEqual(expect.objectContaining({
            HAPPIER_PATH_USER_PATH: `${otherDir};C:\\Tools`,
            HAPPIER_PATH_PROVENANCE_VALUE: otherDir,
            HAPPIER_PATH_MOVES_VALUE: `${otherDir}|C:\\Tools`,
        }));
    });

    it('does not write Windows state when a scoped home has no Desktop records', async () => {
        setPlatform('win32');
        const otherDir = 'C:\\Other Home\\bin';
        execFileMock.mockImplementation((_command, _args, _options, callback) => {
            callback(null, JSON.stringify({ userPath: otherDir, provenance: otherDir, moves: null }), '');
        });
        expect(await removeHappierCliPathExposure({ binDir: 'C:\\Removed Home\\bin', processEnv: { SystemRoot: 'C:\\Windows' } }))
            .toEqual({ removed: false, failure: null });
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('carries the whole user PATH through the child environment, never as -Command argv', async () => {
        setPlatform('win32');
        const binDir = 'C:\\Users\\example\\.happier\\bin';
        // Three entries, so the value contains PowerShell's statement separator twice, plus a
        // space, parentheses and a %VAR% that the parser would mangle if it reached the command.
        const userPath = 'C:\\Program Files (x86)\\Tools;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\example\\bin';
        const processEnv = { SystemRoot: 'C:\\Windows' };
        execFileMock.mockImplementation((_command, _args, _options, callback) => {
            const isRead = execFileMock.mock.calls.length === 1;
            callback(null, isRead ? JSON.stringify({ userPath, userPathKind: 'ExpandString', provenance: null }) : '', '');
        });

        const result = await ensureHappierCliPathExposure({ binDir, processEnv });

        expect(result).toEqual({ changed: true, shellReloadHint: 'Open a new terminal to use happier.', failure: null, existingCommand: null });
        expect(execFileMock).toHaveBeenCalledTimes(2);
        for (const [command, args, options] of execFileMock.mock.calls) {
            expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
            // The script must be the last token: powershell.exe folds every later argument into
            // the command text it parses.
            expect(args.indexOf('-Command')).toBe(args.length - 2);
            const script = args[args.length - 1] ?? '';
            expect(script).not.toContain('param(');
            // Every value handed over must actually be read back inside the script.
            for (const name of Object.keys(options.env ?? {}).filter((key) => key.startsWith('HAPPIER_PATH_'))) {
                expect(script).toContain(`$env:${name}`);
            }
        }

        const [, , readOptions] = execFileMock.mock.calls[0] ?? [];
        expect(readOptions?.env?.HAPPIER_PATH_PROVENANCE_NAME).toBe(HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE);
        const [, , writeOptions] = execFileMock.mock.calls[1] ?? [];
        expect(writeOptions?.env).toEqual(expect.objectContaining({
            SystemRoot: 'C:\\Windows',
            HAPPIER_PATH_USER_PATH: `${binDir};${userPath}`,
            HAPPIER_PATH_VALUE_KIND: 'ExpandString',
            HAPPIER_PATH_PROVENANCE_NAME: HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
            HAPPIER_PATH_PROVENANCE_VALUE: binDir,
        }));
    });

    it('"Keep my own" on Windows puts the moved managed dir back and clears the move record (R13)', async () => {
        setPlatform('win32');
        const binDir = 'C:\\Users\\example\\.happier\\bin';
        const npmDir = 'C:\\Users\\example\\AppData\\Roaming\\npm';
        const processEnv = { SystemRoot: 'C:\\Windows' };
        execFileMock.mockImplementation((_command, _args, _options, callback) => {
            const isRead = execFileMock.mock.calls.length === 1;
            callback(null, isRead ? JSON.stringify({
                userPath: `${binDir};${npmDir}`,
                userPathKind: 'ExpandString',
                provenance: null,
                moves: `${binDir}|${npmDir}`,
            }) : '', '');
        });

        expect(await removeHappierCliPathExposure({ processEnv })).toEqual({ removed: true, failure: null });

        expect(execFileMock).toHaveBeenCalledTimes(2);
        const [, readArgs, readOptions] = execFileMock.mock.calls[0] ?? [];
        const [, writeArgs, writeOptions] = execFileMock.mock.calls[1] ?? [];
        for (const [args, options] of [[readArgs, readOptions], [writeArgs, writeOptions]] as const) {
            const script = args?.[args.length - 1] ?? '';
            for (const name of Object.keys(options?.env ?? {}).filter((key) => key.startsWith('HAPPIER_PATH_'))) {
                expect(script).toContain(`$env:${name}`);
            }
        }
        expect(writeOptions?.env).toEqual(expect.objectContaining({
            HAPPIER_PATH_USER_PATH: `${npmDir};${binDir}`,
            HAPPIER_PATH_MOVES_NAME: HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE,
            HAPPIER_PATH_MOVES_VALUE: '',
        }));
    });
});

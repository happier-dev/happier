import { resolve } from 'path';
import { afterAll, describe, it, expect } from 'vitest';
import { validatePath, validateWorkspaceInspectionPath } from './pathSecurity';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('validatePath', () => {
    const workingRoot = mkdtempSync(join(tmpdir(), 'happier-pathSecurity-working-'));
    const workingDir = join(workingRoot, 'project');
    mkdirSync(workingDir, { recursive: true });
    const canonicalWorkingDir = realpathSync(workingDir);

    afterAll(() => {
        rmSync(workingRoot, { recursive: true, force: true });
    });

    it('should allow paths within working directory', () => {
        expect(validatePath(resolve(workingDir, 'file.txt'), workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(workingDir, 'file.txt'),
        });
        expect(validatePath('file.txt', workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(canonicalWorkingDir, 'file.txt'),
        });
        expect(validatePath('./src/file.txt', workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(canonicalWorkingDir, 'src', 'file.txt'),
        });
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath('/etc/passwd', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('normalizes dot segments but still allows resolved in-root paths', () => {
        const result = validatePath('./src/../notes/todo.txt', workingDir);
        expect(result).toMatchObject({
            valid: true,
            resolvedPath: resolve(canonicalWorkingDir, 'notes', 'todo.txt'),
        });
    });

    it('rejects traversal after normalization when target resolves outside root', () => {
        const result = validatePath('./src/../../../outside.txt', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toMatchObject({ valid: true, resolvedPath: canonicalWorkingDir });
        expect(validatePath(workingDir, workingDir)).toMatchObject({ valid: true, resolvedPath: resolve(workingDir) });
    });

    it('allows paths inside additional allowed directories', () => {
        const testBase = mkdtempSync(join(tmpdir(), 'happier-pathSecurity-extra-'));
        const extra = join(testBase, 'uploads');
        try {
            mkdirSync(extra, { recursive: true });
            expect(validatePath(join(extra, 'session', 'file.jpg'), workingDir, [extra]).valid).toBe(true);
            expect(validatePath(join(extra, 'abc', 'img.png'), workingDir, [extra]).valid).toBe(true);
        } finally {
            rmSync(testBase, { recursive: true, force: true });
        }
    });

    it('rejects traversal outside additional allowed directory', () => {
        const testBase = mkdtempSync(join(tmpdir(), 'happier-pathSecurity-traversal-'));
        const extra = join(testBase, 'uploads');
        try {
            mkdirSync(extra, { recursive: true });
            const result = validatePath(join(extra, '..', '..', 'etc', 'passwd'), workingDir, [extra]);
            expect(result.valid).toBe(false);
        } finally {
            rmSync(testBase, { recursive: true, force: true });
        }
    });

    it('prevents symlink traversal out of an allowed directory', () => {
        const testBase = join(tmpdir(), `happier-pathSecurity-${Date.now()}`);
        const allowedDir = join(testBase, 'uploads');
        const outsideBase = join(tmpdir(), `happier-pathSecurity-outside-${Date.now()}`);
        const outsideDir = join(outsideBase, 'outside');
        const symlinkPath = join(allowedDir, 'evil-link');

        try {
            mkdirSync(allowedDir, { recursive: true });
            mkdirSync(outsideDir, { recursive: true });
            symlinkSync(outsideDir, symlinkPath);

            // The symlink resolves outside the working dir, so it must be rejected.
            const result = validatePath(join(symlinkPath, 'secret.txt'), allowedDir);
            expect(result.valid).toBe(false);
        } finally {
            if (existsSync(testBase)) {
                rmSync(testBase, { recursive: true, force: true });
            }
            if (existsSync(outsideBase)) {
                rmSync(outsideBase, { recursive: true, force: true });
            }
        }
    });

    it('accepts paths that only differ by canonical realpath aliases', () => {
        const testBase = join(tmpdir(), `happier-pathSecurity-canonical-${Date.now()}`);
        const realWorkspace = join(testBase, 'real-workspace');
        const aliasWorkspace = join(testBase, 'alias-workspace');

        try {
            mkdirSync(realWorkspace, { recursive: true });
            symlinkSync(realWorkspace, aliasWorkspace);

            const result = validatePath(join(realWorkspace, 'notes.txt'), aliasWorkspace);
            expect(result).toMatchObject({
                valid: true,
                resolvedPath: join(realWorkspace, 'notes.txt'),
            });
        } finally {
            if (existsSync(testBase)) {
                rmSync(testBase, { recursive: true, force: true });
            }
        }
    });

    it('rejects when working directory is missing or invalid', () => {
        expect(validatePath('file.txt', '')).toEqual({
            valid: false,
            error: 'Access denied: Invalid working directory',
        });
        expect(validatePath('file.txt', null as unknown as string)).toEqual({
            valid: false,
            error: 'Access denied: Invalid working directory',
        });
    });
});

describe('validateWorkspaceInspectionPath', () => {
    it('allows canonical absolute workspace inspection paths outside the working tree', () => {
        expect(validateWorkspaceInspectionPath('/tmp/workspaces/demo')).toEqual({
            valid: true,
            resolvedPath: resolve('/tmp/workspaces/demo'),
        });
    });

    it('rejects relative workspace inspection paths', () => {
        expect(validateWorkspaceInspectionPath('./demo')).toEqual({
            valid: false,
            error: 'Attached workspace candidate path must be absolute',
        });
    });

    it('rejects workspace inspection paths containing null bytes', () => {
        expect(validateWorkspaceInspectionPath('/tmp/demo\0repo')).toEqual({
            valid: false,
            error: 'Attached workspace candidate path contains invalid characters',
        });
    });
});

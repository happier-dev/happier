import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { validatePath } from './pathSecurity';
import { mkdirSync, symlinkSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('validatePath', () => {
    const workingDir = '/home/user/project';

    it('should allow paths within working directory', () => {
        expect(validatePath(resolve(workingDir, 'file.txt'), workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(workingDir, 'file.txt'),
        });
        expect(validatePath('file.txt', workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(workingDir, 'file.txt'),
        });
        expect(validatePath('./src/file.txt', workingDir)).toMatchObject({
            valid: true,
            resolvedPath: resolve(workingDir, 'src', 'file.txt'),
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
            resolvedPath: resolve(workingDir, 'notes', 'todo.txt'),
        });
    });

    it('rejects traversal after normalization when target resolves outside root', () => {
        const result = validatePath('./src/../../../outside.txt', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the allowed directories');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toMatchObject({ valid: true, resolvedPath: resolve(workingDir) });
        expect(validatePath(workingDir, workingDir)).toMatchObject({ valid: true, resolvedPath: resolve(workingDir) });
    });

    it('allows paths inside additional allowed directories', () => {
        const extra = '/tmp/happier/uploads';
        expect(validatePath('/tmp/happier/uploads/session/file.jpg', workingDir, [extra]).valid).toBe(true);
        expect(validatePath('/tmp/happier/uploads/abc/img.png', workingDir, [extra]).valid).toBe(true);
    });

    it('rejects traversal outside additional allowed directory', () => {
        const extra = '/tmp/happier/uploads';
        const result = validatePath('/tmp/happier/uploads/../../etc/passwd', workingDir, [extra]);
        expect(result.valid).toBe(false);
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

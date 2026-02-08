import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { validatePath } from './pathSecurity';

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
        expect(result.error).toContain('outside the working directory');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
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
        expect(result.error).toContain('outside the working directory');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toMatchObject({ valid: true, resolvedPath: resolve(workingDir) });
        expect(validatePath(workingDir, workingDir)).toMatchObject({ valid: true, resolvedPath: resolve(workingDir) });
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

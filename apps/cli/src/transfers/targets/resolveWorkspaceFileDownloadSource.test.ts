import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

import { SOURCE_CONDITION, SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '../policy/serverRoutedTransferPolicy';
import { resolveWorkspaceFileDownloadSource } from './resolveWorkspaceFileDownloadSource';

const createdPaths = new Set<string>();

function createWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-transfer-download-source-'));
    createdPaths.add(workspace);
    return workspace;
}

afterEach(() => {
    for (const path of createdPaths) {
        rmSync(path, { recursive: true, force: true });
    }
    createdPaths.clear();
});

describe('resolveWorkspaceFileDownloadSource', () => {
    it('keeps ZIP cold until demand and creates archives through the compiled split-ESM export', async () => {
        const source = fileURLToPath(new URL('../download/buildZipArchive.ts', import.meta.url));
        const workspace = createWorkspace();
        const outputDir = join(workspace, 'output');
        const result = await build({
            entryPoints: [source], bundle: true, platform: 'node', format: 'esm',
            splitting: true, target: 'node20', metafile: true,
            ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
            conditions: [SOURCE_CONDITION], outdir: outputDir, logLevel: 'silent',
            banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
            define: SOURCE_RUNTIME_COMMONJS_DEFINE,
        });
        const inputs = result.metafile.inputs;
        const entry = Object.keys(inputs).find(key => resolve(key) === source);
        expect(entry).toBeDefined();
        const coldInputs = new Set<string>();
        const pending = [entry!];
        for (const input of pending) {
            if (coldInputs.has(input)) continue;
            coldInputs.add(input);
            for (const dependency of inputs[input]?.imports ?? []) {
                if (!dependency.external && dependency.kind !== 'dynamic-import') pending.push(dependency.path);
            }
        }
        expect([...coldInputs].filter(key => /(?:^|\/)node_modules\/archiver\//.test(key))).toEqual([]);
        expect(Object.keys(inputs).some(key => /node_modules\/archiver\//.test(key))).toBe(true);
        const entryOutput = Object.entries(result.metafile.outputs)
            .find(([, output]) => output.exports.includes('buildZipArchive'));
        expect(entryOutput).toBeDefined();
        writeFileSync(join(outputDir, 'package.json'), '{"type":"module"}');
        const sourcePath = join(workspace, 'hello.txt');
        const zipPath = join(workspace, 'download.zip');
        writeFileSync(sourcePath, 'hello from the compiled ZIP owner\n');
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
            const { buildZipArchive } = await import(process.argv[1]);
            const input = { sourcePath: process.argv[2], zipPath: process.argv[3],
                excludedTopLevelDirs: [], maxEntryCount: 1, maxTotalBytes: 1024, maxOutputBytes: 1024 };
            await buildZipArchive(input);
            let rejected;
            try { await buildZipArchive({ ...input, zipPath: process.argv[4], maxOutputBytes: 1 }); }
            catch (error) { rejected = error.message; }
            console.log(JSON.stringify({ rejected }));
        `, pathToFileURL(resolve(entryOutput![0])).href, sourcePath, zipPath,
            join(workspace, 'too-small.zip')], { encoding: 'utf8' });
        expect(JSON.parse(stdout)).toEqual({ rejected: 'Zip exceeds output size limit' });
        const archive = readFileSync(zipPath);
        expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        expect(archive.includes(Buffer.from('hello.txt'))).toBe(true);
    });

    it('confines a publication download despite a broader OS-user policy, including symlink escapes', async () => {
        const root = createWorkspace();
        mkdirSync(join(root, 'workspace'));
        writeFileSync(join(root, 'private.txt'), 'private');
        symlinkSync(join(root, 'private.txt'), join(root, 'workspace', 'escape.txt'));
        for (const path of ['../private.txt', 'escape.txt']) {
            const request = { workingDirectory: join(root, 'workspace'), path, asZip: false,
                confinedToWorkingDirectory: true };
            await expect(resolveWorkspaceFileDownloadSource(request)).resolves.toMatchObject({ success: false });
        }
    });
    it('allows sources outside the default directory by default', async () => {
        const workspace = createWorkspace();
        const externalRoot = createWorkspace();
        const externalPath = join(externalRoot, 'hello.txt');
        writeFileSync(externalPath, 'hello\n', 'utf8');

        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: externalPath,
            asZip: false,
        });

        expect(result).toMatchObject({
            success: true,
            source: {
                filePath: externalPath,
                deleteFileOnClose: false,
                sizeBytes: 6,
                name: 'hello.txt',
            },
        });
    });

    it('returns a direct file source for non-zip downloads', async () => {
        const workspace = createWorkspace();
        writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'hello.txt',
                asZip: false,
            }),
        ).resolves.toMatchObject({
            success: true,
            source: {
                deleteFileOnClose: false,
                sizeBytes: 6,
                name: 'hello.txt',
            },
        });
        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: 'hello.txt',
            asZip: false,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.source.filePath.endsWith('/hello.txt')).toBe(true);
            expect(result.source.filePath).toContain('happier-transfer-download-source-');
        }
    });

    it('permits an exact transient media file outside restricted roots without permitting its sibling', async () => {
        const workspace = createWorkspace();
        const providerDirectory = createWorkspace();
        const grantedPath = join(providerDirectory, 'provider-owned.png');
        const siblingPath = join(providerDirectory, 'sibling-secret.png');
        writeFileSync(grantedPath, 'media', 'utf8');
        writeFileSync(siblingPath, 'secret', 'utf8');
        const grantedRealPath = realpathSync(grantedPath);

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: grantedPath,
                asZip: false,
                accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
                additionalAllowedReadFiles: [{ path: grantedPath, realPath: grantedRealPath }],
            }),
        ).resolves.toMatchObject({
            success: true,
            source: { filePath: grantedPath },
        });
        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: siblingPath,
                asZip: false,
                accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
                additionalAllowedReadFiles: [{ path: grantedPath, realPath: grantedRealPath }],
            }),
        ).resolves.toMatchObject({ success: false });
    });

    it('rejects directory downloads unless zip mode is requested', async () => {
        const workspace = createWorkspace();
        mkdirSync(join(workspace, 'folder'), { recursive: true });

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'folder',
                asZip: false,
            }),
        ).resolves.toEqual({
            success: false,
            error: 'Download is only supported for files',
        });
    });

    it('builds a temporary zip source for directory downloads', async () => {
        const workspace = createWorkspace();
        mkdirSync(join(workspace, 'folder'), { recursive: true });
        writeFileSync(join(workspace, 'folder', 'hello.txt'), 'hello\n', 'utf8');

        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: 'folder',
            asZip: true,
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.source.deleteFileOnClose).toBe(true);
        expect(result.source.name).toBe('folder.zip');
        expect(result.source.sizeBytes).toBeGreaterThan(0);
        expect(existsSync(result.source.filePath)).toBe(true);
        createdPaths.add(result.source.filePath);
    });

    it('fails closed when the selected session-routed size limit is exceeded', async () => {
        const workspace = createWorkspace();
        writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'hello.txt',
                asZip: false,
                sessionRpcTransferMaxBytes: 4,
            }),
        ).resolves.toEqual({
            success: false,
            error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
        });
    });
});

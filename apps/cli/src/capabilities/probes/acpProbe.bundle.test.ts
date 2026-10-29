import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { isPidProvablyAbsent } from '@happier-dev/cli-common/process';

import { createWorkspaceSourceResolver, readWorkspacePackages, SOURCE_CONDITION, SOURCE_RUNTIME_OUTPUT_OPTIONS } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';

it('retires the native ACP probe tree through the compiled host module', async ({ task }) => {
    await withTempDir('happier-acp-probe-bundle-', async root => {
        const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
        const cliDir = join(repoDir, 'apps/cli');
        const workspacePackages = await readWorkspacePackages(repoDir);
        const requireFromProject = createRequire(join(cliDir, 'package.json'));
        const output = join(root, 'package-dist', 'probe.mjs');
        await build({
            absWorkingDir: repoDir,
            entryPoints: [fileURLToPath(new URL('./acpProbe.ts', import.meta.url))],
            outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'node20',
            ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
            conditions: [SOURCE_CONDITION], logLevel: 'silent', tsconfig: join(cliDir, 'tsconfig.json'),
            plugins: [createWorkspaceSourceResolver({ workspacePackages, requireFromProject })],
            banner: { js: "import { createRequire as __artifactCreateRequire } from 'node:module'; import { fileURLToPath as __artifactFileURLToPath } from 'node:url'; import { dirname as __artifactDirname } from 'node:path'; const require = __artifactCreateRequire(import.meta.url); const __artifactFilename = __artifactFileURLToPath(import.meta.url); const __artifactDirectory = __artifactDirname(__artifactFilename);" },
            define: { __dirname: '__artifactDirectory', __filename: '__artifactFilename' },
        });
        // The shipped tree owner remains an asset of the compiled CLI module.
        await mkdir(join(root, 'scripts'));
        await copyFile(join(cliDir, 'scripts', 'process_tree.cjs'), join(root, 'scripts', 'process_tree.cjs'));
        const fixture = createDaemonizingProcessFixture(root);
        const abortPath = join(root, 'abort');
        const controller = new AbortController();
        const host = promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
            import { watch } from 'node:fs';
            const [url, cwd, args, abortPath] = JSON.parse(process.argv[1]);
            const { probeAcpAgentCapabilities } = await import(url);
            const controller = new AbortController();
            const watcher = watch(cwd, (_event, name) => {
                if (String(name) === 'abort') controller.abort();
            });
            try {
                const result = await probeAcpAgentCapabilities({ command: process.execPath, args, cwd, env: {},
                    transport: { agentName: 'compiled-probe', filterStdoutLine: line => line.startsWith('{') ? line : null },
                    timeoutMs: null, signal: controller.signal });
                process.stdout.write(JSON.stringify({ ok: result.ok }));
            } finally { watcher.close(); }
        `, JSON.stringify([pathToFileURL(output).href, root, fixture.args, abortPath])],
        { cwd: root, encoding: 'utf8', signal: controller.signal, timeout: task.timeout });
        void host.catch(() => undefined);
        try {
            const descendantPid = await fixture.ready({ launch: host, timeoutMs: task.timeout });
            await writeFile(abortPath, 'abort');
            const result = await host;
            expect(JSON.parse(result.stdout)).toEqual({ ok: false });
            expect(await waitForProcessExit(descendantPid)).toBe(true);
        } finally {
            controller.abort();
            await host.catch(() => undefined);
            const receipt = await readFile(join(root, 'ready.json'), 'utf8')
                .then(value => JSON.parse(value) as { rootPid: number }).catch(() => undefined);
            if (receipt && !isPidProvablyAbsent(receipt.rootPid)) {
                try { process.kill(receipt.rootPid, 'SIGKILL'); } catch { /* Exact fixture root only. */ }
                await waitForProcessExit(receipt.rootPid);
            }
            await fixture.cleanup();
        }
    });
}, 60_000);

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createLightSqliteHarness } from './testkit/lightSqliteHarness';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

it.skipIf(process.platform === 'win32')('flushes a CPU profile when Stack stops the light server after cleanup', async () => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-server-shutdown-profile-' });
    const scratch = harness.baseDir;
    // Exercise the same real stop and grace owners used by run.mjs/dev.mjs.
    // Dynamic paths keep Stack's development tooling outside the server TS project.
    const stackUtils = '../../stack/scripts/utils/';
    const { killProcessTree } = await import(`${stackUtils}proc/proc.mjs`);
    const { resolveServerShutdownGraceMs } = await import(`${stackUtils}server/shutdown_grace.mjs`);
    const { pickNextFreeTcpPort } = await import(`${stackUtils}net/ports.mjs`);
    const { waitForServerReady } = await import(`${stackUtils}server/server.mjs`);
    const preload = join(scratch, 'remaining-handle.cjs');
    // A referenced OS timer represents a handle surviving completed cleanup.
    // The executable must terminate after shutdown even if the loop cannot drain.
    await writeFile(preload, 'setInterval(() => {}, 60_000);\n');
    const dotenvPath = join(scratch, 'empty.env');
    await writeFile(dotenvPath, '');
    const port = await pickNextFreeTcpPort(40_000);
    const env = {
        ...harness.envBase,
        NODE_OPTIONS: '',
        TSX_TSCONFIG_PATH: join(serverDir, 'tsconfig.json'),
        DOTENV_CONFIG_PATH: dotenvPath,
        HAPPIER_DB_PROVIDER: 'sqlite', HAPPY_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: scratch, HAPPY_SERVER_LIGHT_DATA_DIR: scratch,
        HAPPIER_SERVER_LIGHT_FILES_DIR: join(scratch, 'files'), HAPPY_SERVER_LIGHT_FILES_DIR: join(scratch, 'files'),
        HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(scratch, 'private'), HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR: join(scratch, 'private'),
        HAPPIER_SQLITE_AUTO_MIGRATE: '1', HAPPY_SQLITE_AUTO_MIGRATE: '1',
        HAPPIER_SERVER_HOST: '127.0.0.1', PORT: String(port),
        HAPPIER_PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
        HAPPIER_CANONICAL_SERVER_URL: `http://127.0.0.1:${port}`,
        SERVER_ROLE: 'api', METRICS_ENABLED: 'false', REDIS_URL: '',
        HAPPIER_SERVER_LOG_FORMAT: 'json',
    };
    const child = spawn(process.execPath, [
        '--cpu-prof', `--cpu-prof-dir=${scratch}`, '--cpu-prof-interval=10000', '--disable-sigusr1',
        '--require', preload, '--import', require.resolve('tsx/esm'), join(serverDir, 'sources/main.light.ts'),
    ], { cwd: serverDir, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const closed = once(child, 'close');
    try {
        try {
            await waitForServerReady(`http://127.0.0.1:${port}`, { childProcess: child, continueWhileChildAlive: false });
        } catch (error) {
            const diagnostic = stderr.split('\n').filter(line => !/token|secret|key|bearer|password|jws|seed|credential|authorization|:\/\//i.test(line)).join('\n');
            throw new Error(`${error instanceof Error ? error.message : 'Server startup failed'}\n${diagnostic}`);
        }
        const stopped = await killProcessTree(child, 'SIGINT', { graceMs: resolveServerShutdownGraceMs(env) });
        const [code, signal] = await closed;
        // tsx may also profile its loader worker. Assert the server's main thread.
        const profiles = (await readdir(scratch)).filter(name =>
            name.endsWith('.cpuprofile') && name.includes(`.${child.pid}.0.`));
        expect(profiles, `stop=${JSON.stringify(stopped)}, exit=${code}/${signal}`).toHaveLength(1);
        const profileBytes = (await stat(join(scratch, profiles[0]))).size;
        expect(profileBytes).toBeGreaterThan(0);
        expect(JSON.parse(await readFile(join(scratch, profiles[0]), 'utf8')).nodes.length).toBeGreaterThan(0);
        expect(code).toBe(0);
        expect(signal).toBeNull();
        console.info(JSON.stringify({ node: process.version, profileBytes, exitCode: code, signal }));
    } finally {
        if (child.exitCode == null && child.signalCode == null) await killProcessTree(child, 'SIGKILL');
        await closed;
        await harness.close();
    }
}, 120_000);

import { mkdtemp, rm, writeFile, chmod, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isPluginError } from '@happier-dev/plugin-sdk';

import { createPluginExecSystemToolResolver } from './resolveGrant';
import type { PluginExecSystemToolDefinition } from './definitions';

const temporaryRoots = new Set<string>();

afterEach(async () => {
    await Promise.all([...temporaryRoots].map(async (root) => {
        await rm(root, { recursive: true, force: true });
        temporaryRoots.delete(root);
    }));
});

type FixtureAcpMode = 'current' | 'legacy' | 'malformed' | 'exit' | 'hang';
type FixtureSurfaceMode = 'supported' | 'unsupported' | 'hang';

const CURRENT_CAPABILITIES = {
    loadSession: true,
    sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
};

const LEGACY_CAPABILITIES = {
    loadSession: true,
    sessionCapabilities: { list: {}, resume: {} },
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false },
};

/**
 * Provider-shaped readiness declaration under test. The versions below are
 * deliberately deceptive: the retired Python CLI reports 1.49.0 while current
 * Kimi Code reports 0.1.1, so any numeric semver ordering would crown the
 * legacy runtime. Selection must follow the observed ACP fingerprint and the
 * `migrate` command surface instead, and must never spawn a version probe.
 */
const KIMI_SHAPED_READINESS = {
    acpProbeArgs: ['acp'],
    currentFingerprint: {
        loadSession: true,
        sessionCapabilities: ['list', 'resume', 'close', 'delete', 'fork'],
        absentSessionCapabilities: [],
        mcpHttp: true,
        mcpSse: true,
    },
    legacyFingerprint: {
        loadSession: true,
        sessionCapabilities: ['list', 'resume'],
        absentSessionCapabilities: ['close', 'delete', 'fork'],
        mcpHttp: true,
        mcpSse: false,
    },
    commandSurfaceArgs: ['migrate', '--help'],
    legacyExecutableNames: ['kimi-cli'],
    legacyGuidance:
        'Install the current Kimi Code CLI, then run `kimi migrate` manually. Happier never runs migration automatically.',
    unidentifiedGuidance: 'Install the current Kimi Code CLI and retry.',
} as const;

function kimiDefinition(): PluginExecSystemToolDefinition {
    return {
        toolId: 'kimi-cli',
        displayName: 'Kimi Code CLI',
        lookupNames: ['kimi'],
        readiness: {
            acpProbeArgs: [...KIMI_SHAPED_READINESS.acpProbeArgs],
            currentFingerprint: {
                ...KIMI_SHAPED_READINESS.currentFingerprint,
                sessionCapabilities: [...KIMI_SHAPED_READINESS.currentFingerprint.sessionCapabilities],
                absentSessionCapabilities: [...KIMI_SHAPED_READINESS.currentFingerprint.absentSessionCapabilities],
            },
            legacyFingerprint: {
                ...KIMI_SHAPED_READINESS.legacyFingerprint,
                sessionCapabilities: [...KIMI_SHAPED_READINESS.legacyFingerprint.sessionCapabilities],
                absentSessionCapabilities: [...KIMI_SHAPED_READINESS.legacyFingerprint.absentSessionCapabilities],
            },
            commandSurfaceArgs: [...KIMI_SHAPED_READINESS.commandSurfaceArgs],
            legacyExecutableNames: [...KIMI_SHAPED_READINESS.legacyExecutableNames],
            legacyGuidance: KIMI_SHAPED_READINESS.legacyGuidance,
            unidentifiedGuidance: KIMI_SHAPED_READINESS.unidentifiedGuidance,
        },
    };
}

function resolveSdkEntry(): string {
    const requireFromHere = createRequire(import.meta.url);
    return requireFromHere.resolve('@agentclientprotocol/sdk', { paths: [process.cwd()] });
}

/**
 * Writes a fake `kimi` executable that answers from a genuine OS process
 * boundary: a real spawn, a real NDJSON ACP initialize exchange through the
 * installed ACP SDK, and a real `migrate --help` exit code. Every invocation
 * appends its argv to the log file so tests can prove version probes never run.
 */
async function writeKimiFixture(params: Readonly<{
    dir: string;
    name?: string;
    acpMode: FixtureAcpMode;
    surface: FixtureSurfaceMode;
    version: string;
    capabilities?: unknown;
    invocationLog: string;
    acpDelayMs?: number;
    surfaceDelayMs?: number;
    processLog?: string;
}>): Promise<string> {
    const filePath = join(params.dir, params.name ?? 'kimi');
    const caps = JSON.stringify(params.capabilities ?? CURRENT_CAPABILITIES);
    const source = `#!${process.execPath}
const fs = require('node:fs');
const logFile = ${JSON.stringify(params.invocationLog)};
const argv = process.argv.slice(2);
try { fs.appendFileSync(logFile, JSON.stringify(argv) + '\\n'); } catch {}
const MODE = ${JSON.stringify(params.acpMode)};
const processLog = ${JSON.stringify(params.processLog ?? null)};
if (processLog) fs.appendFileSync(processLog, JSON.stringify({ pid: process.pid, command: argv[0] }) + String.fromCharCode(10));
const SURFACE = ${JSON.stringify(params.surface)};
async function main() {
  if (argv[0] === 'migrate') {
    if (SURFACE === 'hang') { process.stdin.resume(); await new Promise(() => {}); return; }
    await new Promise((resolve) => setTimeout(resolve, ${params.surfaceDelayMs ?? 0}));
    if (SURFACE === 'supported') { process.stdout.write('Migrate Kimi CLI state.\\n'); return; }
    process.stderr.write("Usage: kimi [OPTIONS] COMMAND [ARGS]...\\nNo such command 'migrate'.\\n");
    process.exit(2);
  }
  if (argv[0] !== 'acp') { process.stderr.write('unknown command\\n'); process.exit(2); }
  if (MODE === 'exit') process.exit(7);
  if (MODE === 'hang') { process.stdin.resume(); await new Promise(() => {}); return; }
  if (MODE === 'malformed') {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let id = 1;
      try { id = JSON.parse(line).id ?? 1; } catch {}
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { malformed: true } }) + '\\n');
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return;
  }
  const { pathToFileURL } = require('node:url');
  const acp = await import(pathToFileURL(${JSON.stringify(resolveSdkEntry())}).href);
  const { Readable, Writable } = require('node:stream');
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const caps = ${caps};
  const app = acp.agent({ name: 'fixture-kimi' }).onRequest('initialize', async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: caps,
  }));
  await new Promise((resolve) => setTimeout(resolve, ${params.acpDelayMs ?? 0}));
  const connection = app.connect(stream);
  await connection.closed;
}
main().then(() => process.exit(0), () => process.exit(1));
`;
    await writeFile(filePath, source, 'utf8');
    await chmod(filePath, 0o755);
    return filePath;
}

async function writeLegacyNameFixture(params: Readonly<{
    dir: string;
    invocationLog: string;
    markerFile: string;
}>): Promise<string> {
    // A retired `kimi-cli` binary. If the resolver ever launches it as the
    // current runtime, the marker file proves the violation.
    const filePath = join(params.dir, 'kimi-cli');
    const source = `#!${process.execPath}
const fs = require('node:fs');
try { fs.appendFileSync(${JSON.stringify(params.invocationLog)}, JSON.stringify(process.argv.slice(2)) + '\\n'); } catch {}
try { fs.writeFileSync(${JSON.stringify(params.markerFile)}, 'launched'); } catch {}
process.stderr.write('kimi-cli legacy\\n');
process.exit(2);
`;
    await writeFile(filePath, source, 'utf8');
    await chmod(filePath, 0o755);
    return filePath;
}

async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happier-kimi-readiness-'));
    temporaryRoots.add(root);
    return root;
}

function resolverForPath(pathValue: string) {
    return createPluginExecSystemToolResolver({
        definitions: [kimiDefinition()],
        baseEnv: { PATH: pathValue },
        registerGrant() {},
    });
}

async function readLogLines(logFile: string): Promise<readonly (readonly string[])[]> {
    try {
        const { readFile } = await import('node:fs/promises');
        const text = await readFile(logFile, 'utf8');
        return text.split('\n').filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as readonly string[]);
    } catch {
        return [];
    }
}

function invocationsIncludeVersionProbe(lines: readonly (readonly string[])[]): boolean {
    return lines.some((argv) => argv.some((arg) => arg === '--version' || arg === 'version' || arg === '-v'));
}

describe('system tool readiness (capability fingerprint, never semver)', () => {
    it('waits for current ACP readiness beyond the diagnostic probe budget', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const current = await writeKimiFixture({
            dir: root, acpMode: 'current', surface: 'supported', version: '0.1.1',
            invocationLog: join(root, 'invocations.log'), acpDelayMs: 2_800,
        });

        const grant = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' });

        expect(grant.executablePath).toBe(current);
    }, 20_000);

    it('selects known-current ACP beyond the diagnostic surface policy without invoking its hanging command', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const processLog = join(root, 'processes.log');
        const current = await writeKimiFixture({
            dir: root, acpMode: 'current', surface: 'hang', version: '0.1.1',
            invocationLog: join(root, 'invocations.log'), processLog,
        });

        const grant = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' });

        expect(grant.executablePath).toBe(current);
        const { readFile } = await import('node:fs/promises');
        const processes = (await readFile(processLog, 'utf8')).trim().split('\n')
            .map((line) => JSON.parse(line) as { command: string });
        expect(processes.some((child) => child.command === 'migrate')).toBe(false);
    }, 20_000);

    it('waits for a responsive command surface instead of inheriting legacy-name guidance', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        await writeKimiFixture({
            dir: root, acpMode: 'exit', surface: 'supported', version: '0.1.1',
            invocationLog: log, surfaceDelayMs: 1_300,
        });
        await writeLegacyNameFixture({ dir: root, invocationLog: log, markerFile: join(root, 'legacy-launched') });

        const failure = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' })
            .then(() => undefined, (error: unknown) => error);

        expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_unidentified' });
    }, 20_000);

    it.each(['acp', 'migrate'] as const)('cancels both pending readiness phases (%s) and observes process exit before returning', async (phase) => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const processLog = join(root, 'processes.log');
        await writeKimiFixture({
            dir: root, acpMode: phase === 'acp' ? 'hang' : 'exit', surface: 'hang', version: '0.1.1',
            invocationLog: join(root, 'invocations.log'), processLog,
        });
        const controller = new AbortController();
        const pending = resolverForPath(root).resolve({
            toolId: 'kimi-cli', purpose: 'test', signal: controller.signal,
        }).then(() => undefined, (error: unknown) => error);
        const { readFile } = await import('node:fs/promises');
        let processes: Array<{ pid: number; command: string }> = [];
        try {
            await expect.poll(async () => {
                const text = await readFile(processLog, 'utf8').catch(() => '');
                processes = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; command: string });
                return processes.some((child) => child.command === phase);
            }, { timeout: 10_000 }).toBe(true);
            controller.abort();
            const failure = await pending;
            expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_aborted' });
            for (const { pid } of processes) {
                expect(() => process.kill(pid, 0)).toThrow();
            }
        } finally {
            controller.abort();
            await pending;
        }
    }, 20_000);

    it('resolves a current-only install to its kimi executable', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        const current = await writeKimiFixture({
            dir: root, acpMode: 'current', surface: 'supported', version: '0.1.1', invocationLog: log,
        });

        const grant = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' });

        expect(grant.executablePath).toBe(current);
        expect(grant.launch.executablePath).toBe(current);
    }, 20_000);

    it('rejects a legacy-only install with actionable kimi migrate guidance', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        const marker = join(root, 'legacy-launched');
        await writeKimiFixture({
            dir: root, acpMode: 'legacy', surface: 'unsupported', version: '1.49.0', invocationLog: log,
            capabilities: LEGACY_CAPABILITIES,
        });
        await writeLegacyNameFixture({ dir: root, invocationLog: log, markerFile: marker });

        const failure = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' })
            .then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_exec_system_tool_legacy',
            diagnostics: [{ code: 'system_tool_legacy', severity: 'error' }],
        });
        expect(String((failure as { message?: unknown }).message)).toContain('kimi migrate');
        const { readFile } = await import('node:fs/promises');
        await expect(readFile(marker, 'utf8').then(() => true, () => false)).resolves.toBe(false);
    }, 20_000);

    it('detects a legacy-only install that kept just the kimi-cli name', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        const marker = join(root, 'legacy-launched');
        await writeLegacyNameFixture({ dir: root, invocationLog: log, markerFile: marker });

        const failure = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' })
            .then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_exec_system_tool_legacy',
            diagnostics: [{ code: 'system_tool_legacy', severity: 'error' }],
        });
        expect(String((failure as { message?: unknown }).message)).toContain('kimi migrate');
    }, 20_000);

    it('prefers current over an earlier legacy candidate without comparing versions', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const { mkdir } = await import('node:fs/promises');
        const legacyDir = join(root, 'legacy');
        const currentDir = join(root, 'current');
        await mkdir(legacyDir, { recursive: true });
        await mkdir(currentDir, { recursive: true });
        const log = join(root, 'invocations.log');
        const marker = join(root, 'legacy-launched');
        await writeKimiFixture({
            dir: legacyDir, acpMode: 'legacy', surface: 'unsupported', version: '1.49.0',
            invocationLog: log, capabilities: LEGACY_CAPABILITIES,
        });
        await writeLegacyNameFixture({ dir: legacyDir, invocationLog: log, markerFile: marker });
        const current = await writeKimiFixture({
            dir: currentDir, acpMode: 'current', surface: 'supported', version: '0.1.1', invocationLog: log,
        });

        const grant = await resolverForPath(`${legacyDir}${delimiter}${currentDir}`)
            .resolve({ toolId: 'kimi-cli', purpose: 'test' });

        expect(grant.executablePath).toBe(current);
        const lines = await readLogLines(log);
        expect(invocationsIncludeVersionProbe(lines)).toBe(false);
        const { readFile } = await import('node:fs/promises');
        await expect(readFile(marker, 'utf8').then(() => true, () => false)).resolves.toBe(false);
    }, 30_000);

    it('fails truthfully on an explicit exited candidate without legacy guidance', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        const broken = await writeKimiFixture({
            dir: root, name: 'broken-kimi', acpMode: 'exit', surface: 'unsupported', version: '0.1.1',
            invocationLog: log,
        });

        const failure = await resolverForPath('').resolve({
            toolId: 'kimi-cli',
            purpose: 'test',
            preferredPath: broken,
        }).then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_exec_system_tool_unidentified',
            diagnostics: [{ code: 'system_tool_unidentified', severity: 'error' }],
        });
        expect(String((failure as { message?: unknown }).message)).toMatch(/could not identify/i);
        expect(String((failure as { message?: unknown }).message)).not.toContain('kimi migrate');
    }, 30_000);

    it('classifies an explicit legacy override with manual migration guidance', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        const explicit = await writeKimiFixture({
            dir: root, name: 'legacy-kimi', acpMode: 'legacy', surface: 'unsupported', version: '1.49.0',
            invocationLog: log, capabilities: LEGACY_CAPABILITIES,
        });

        const failure = await resolverForPath('').resolve({
            toolId: 'kimi-cli',
            purpose: 'test',
            preferredPath: explicit,
        }).then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_exec_system_tool_legacy',
            diagnostics: [{ code: 'system_tool_legacy', severity: 'error' }],
        });
        expect(String((failure as { message?: unknown }).message)).toContain('kimi migrate');
    }, 20_000);

    it('keeps a PATH-discovered silent install without a legacy fingerprint unidentified', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        await writeKimiFixture({
            dir: root, acpMode: 'exit', surface: 'unsupported', version: '1.49.0', invocationLog: log,
        });

        const failure = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' })
            .then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_unidentified' });
        expect(String((failure as { message?: unknown }).message)).not.toContain('kimi migrate');
    }, 30_000);

    it('fails truthfully when a migrate-capable install stops answering ACP', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        await writeKimiFixture({
            dir: root, acpMode: 'exit', surface: 'supported', version: '0.1.1', invocationLog: log,
        });

        const failure = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' })
            .then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_unidentified' });
        expect(String((failure as { message?: unknown }).message)).not.toContain('kimi migrate');
    }, 30_000);

    it('rejects malformed initialize payloads instead of launching them', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        await writeKimiFixture({
            dir: root, acpMode: 'malformed', surface: 'unsupported', version: '1.49.0', invocationLog: log,
        });

        const failure = await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' })
            .then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_unidentified' });
        expect(String((failure as { message?: unknown }).message)).not.toContain('kimi migrate');
    }, 20_000);

    it('never consults version output when selecting', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const log = join(root, 'invocations.log');
        await writeKimiFixture({
            dir: root, acpMode: 'current', surface: 'supported', version: '0.1.1', invocationLog: log,
        });

        await resolverForPath(root).resolve({ toolId: 'kimi-cli', purpose: 'test' });

        expect(invocationsIncludeVersionProbe(await readLogLines(log))).toBe(false);
    }, 20_000);

    it('keeps tools without a readiness declaration on plain executable resolution', async () => {
        if (process.platform === 'win32') return;
        const root = await makeRoot();
        const toolPath = join(root, 'plain');
        await writeFile(toolPath, `#!${process.execPath}\nprocess.exit(0);\n`, 'utf8');
        await chmod(toolPath, 0o755);

        const grant = await createPluginExecSystemToolResolver({
            definitions: [{ toolId: 'plain-tool', displayName: 'Plain', lookupNames: ['plain'] }],
            baseEnv: { PATH: root },
            registerGrant() {},
        }).resolve({ toolId: 'plain-tool', purpose: 'test' });

        expect(grant.executablePath).toBe(toolPath);
    });

    it('projects a manifest readiness declaration onto the resolver definition', async () => {
        const { projectPluginSystemToolContributions } = await import('./definitions');
        const projected = projectPluginSystemToolContributions([{
            id: 'kimi-cli',
            title: 'Kimi Code CLI',
            executableNames: ['kimi'],
            readiness: {
                acpProbeArgs: ['acp'],
                currentFingerprint: {
                    loadSession: true,
                    sessionCapabilities: ['list', 'resume', 'close', 'delete', 'fork'],
                    absentSessionCapabilities: [],
                    mcpHttp: true,
                    mcpSse: true,
                },
                legacyFingerprint: {
                    loadSession: true,
                    sessionCapabilities: ['list', 'resume'],
                    absentSessionCapabilities: ['close', 'delete', 'fork'],
                    mcpHttp: true,
                    mcpSse: false,
                },
                commandSurfaceArgs: ['migrate', '--help'],
                legacyExecutableNames: ['kimi-cli'],
                legacyGuidance: 'Install the current Kimi Code CLI, then run `kimi migrate` manually.',
                unidentifiedGuidance: 'Install the current Kimi Code CLI and retry.',
            },
        }]);
        expect(projected[0]?.readiness).toMatchObject({
            legacyExecutableNames: ['kimi-cli'],
            commandSurfaceArgs: ['migrate', '--help'],
        });
    });
});

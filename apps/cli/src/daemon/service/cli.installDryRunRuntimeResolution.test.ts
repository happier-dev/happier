import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    ensureJavaScriptRuntimeExecutableMock,
    resolveJavaScriptRuntimeExecutableMock,
    resolveDaemonServiceRuntimeTargetMock,
    planDaemonServiceInstallMock,
} = vi.hoisted(() => ({
    ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/node'),
    resolveJavaScriptRuntimeExecutableMock: vi.fn(() => null),
    resolveDaemonServiceRuntimeTargetMock: vi.fn(() => ({
        nodePath: '/managed/node',
        entryPath: '/opt/happier/package-dist/index.mjs',
    })),
    planDaemonServiceInstallMock: vi.fn(() => ({ files: [], commands: [] })),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
    ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/runtime/js/resolveJavaScriptRuntimeExecutable', () => ({
    resolveJavaScriptRuntimeExecutable: resolveJavaScriptRuntimeExecutableMock,
}));

vi.mock('./runtimeTarget', () => ({
    resolveDaemonServiceRuntimeTarget: resolveDaemonServiceRuntimeTargetMock,
}));

vi.mock('./plan', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./plan')>();
    return {
        ...actual,
        planDaemonServiceInstall: planDaemonServiceInstallMock,
    };
});

function captureStdout(): string[] {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
        ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
            stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
            if (typeof encoding === 'function') encoding(null);
            else if (typeof callback === 'function') callback(null);
            return true;
        }) as typeof process.stdout.write,
    );
    return stdout;
}

describe('runDaemonServiceCliCommand install dry-run runtime resolution', () => {
    const envBackup = { ...process.env };

    afterEach(() => {
        for (const key of Object.keys(process.env)) {
            if (!(key in envBackup)) delete process.env[key];
        }
        Object.assign(process.env, envBackup);
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('uses the managed node runtime when dry-run planning a service install', async () => {
        process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = '/home/test';
        process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = '/home/test/.happier';

        const stdout = captureStdout();
        const { runDaemonServiceCliCommand } = await import('./cli.js');

        await runDaemonServiceCliCommand({
            argv: ['install', '--dry-run', '--json'],
        });

        expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({
            isBunRuntime: false,
            currentExecPath: process.execPath,
        });
        expect(resolveDaemonServiceRuntimeTargetMock).toHaveBeenCalledWith(
            expect.objectContaining({
                runtimeExecutable: '/managed/node',
            }),
        );
        expect(planDaemonServiceInstallMock).toHaveBeenCalledWith(
            expect.objectContaining({
                nodePath: '/managed/node',
                entryPath: '/opt/happier/package-dist/index.mjs',
            }),
        );

        const payload = JSON.parse(stdout.join('').trim()) as { ok: boolean };
        expect(payload.ok).toBe(true);
    });
});

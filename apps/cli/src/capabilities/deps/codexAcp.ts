import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { configuration } from '@/configuration';
import { CODEX_ACP_DIST_TAG } from '@happier-dev/protocol/installables';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

const execFileAsync = promisify(execFile);

export const CODEX_ACP_NPM_PACKAGE = '@zed-industries/codex-acp';
export const DEFAULT_CODEX_ACP_INSTALL_SPEC = `${CODEX_ACP_NPM_PACKAGE}@${CODEX_ACP_DIST_TAG}`;

export const codexAcpInstallDir = () => join(configuration.happyHomeDir, 'tools', 'codex-acp');

export const codexAcpBinPath = () => {
    const binName = process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp';
    return join(codexAcpInstallDir(), 'node_modules', '.bin', binName);
};

const codexAcpStatePath = () => join(codexAcpInstallDir(), 'install-state.json');

function normalizeCodexAcpInstallSpecCandidate(raw: unknown): string | null {
    const spec = typeof raw === 'string' ? raw.trim() : '';
    if (!spec) return null;
    // The install spec is intended to be an npm install target (package spec / URL / file:),
    // and we pass it as a single argv element. If it contains whitespace, it is almost
    // certainly a misconfigured setting (e.g. pasted instructions). Ignore it and fall back
    // to the default install spec.
    if (/\s/.test(spec)) return null;
    return spec;
}

async function readCodexAcpState(): Promise<{ lastInstallLogPath: string | null } | null> {
    try {
        const raw = await readFile(codexAcpStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        const lastInstallLogPath = typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null;
        return { lastInstallLogPath };
    } catch {
        return null;
    }
}

async function writeCodexAcpState(next: { lastInstallLogPath: string | null }): Promise<void> {
    await mkdir(codexAcpInstallDir(), { recursive: true });
    await writeFile(codexAcpStatePath(), JSON.stringify(next, null, 2), 'utf8');
}

async function readInstalledNpmPackageVersion(opts: { installDir: string; packageName: string }): Promise<string | null> {
    try {
        const pkgPath = join(opts.installDir, 'node_modules', opts.packageName, 'package.json');
        const raw = await readFile(pkgPath, 'utf8');
        const parsed = JSON.parse(raw);
        const version = typeof parsed?.version === 'string' ? parsed.version : null;
        return version;
    } catch {
        return null;
    }
}

async function readNpmDistTagVersion(opts: { packageName: string; distTag: string }): Promise<string | null> {
    try {
        const invocation = resolveWindowsCommandInvocation({
            command: 'npm',
            args: ['view', `${opts.packageName}@${opts.distTag}`, 'version'],
            env: process.env,
            resolveCommandOnPath: true,
        });
        const { stdout } = await execFileAsync(invocation.command, invocation.args, {
            timeout: 10_000,
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
        const text = typeof stdout === 'string' ? stdout.trim() : '';
        return text || null;
    } catch {
        return null;
    }
}

async function installNpmDepToPrefix(opts: {
    installDir: string;
    installSpec: string;
    logPath: string;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    try {
        await mkdir(opts.installDir, { recursive: true });
        await mkdir(dirname(opts.logPath), { recursive: true });
        const invocation = resolveWindowsCommandInvocation({
            command: 'npm',
            args: ['install', '--no-audit', '--no-fund', '--prefix', opts.installDir, opts.installSpec],
            env: process.env,
            resolveCommandOnPath: true,
        });
        const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
            timeout: 15 * 60_000,
            windowsHide: true,
            maxBuffer: 50 * 1024 * 1024,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });

        await writeFile(
            opts.logPath,
            [`# installSpec: ${opts.installSpec}`, '', '## stdout', stdout ?? '', '', '## stderr', stderr ?? ''].join('\n'),
            'utf8',
        );

        return { ok: true };
    } catch (e) {
        const message = e instanceof Error ? e.message : 'Install failed';
        try {
            await mkdir(dirname(opts.logPath), { recursive: true });
            await writeFile(opts.logPath, `# installSpec: ${opts.installSpec}\n\n${message}\n`, 'utf8');
        } catch { }
        return { ok: false, errorMessage: message };
    }
}

export async function installCodexAcp(installSpecOverride?: string): Promise<
    | { ok: true; logPath: string }
    | { ok: false; errorMessage: string; logPath: string }
> {
    const logPath = join(configuration.logsDir, `install-dep-codex-acp-${Date.now()}.log`);

    const installSpec =
        normalizeCodexAcpInstallSpecCandidate(installSpecOverride) ??
        normalizeCodexAcpInstallSpecCandidate(process.env.HAPPIER_CODEX_ACP_INSTALL_SPEC) ??
        DEFAULT_CODEX_ACP_INSTALL_SPEC;

    const result = await installNpmDepToPrefix({
        installDir: codexAcpInstallDir(),
        installSpec,
        logPath,
    });

    try {
        await writeCodexAcpState({ lastInstallLogPath: logPath });
    } catch { }

    if (!result.ok) {
        return { ok: false, errorMessage: result.errorMessage, logPath };
    }

    return { ok: true, logPath };
}

export type CodexAcpDepData = {
    installed: boolean;
    installDir: string;
    binPath: string | null;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: { ok: true; latestVersion: string | null } | { ok: false; errorMessage: string };
};

export async function getCodexAcpDepStatus(opts?: {
    includeRegistry?: boolean;
    onlyIfInstalled?: boolean;
    distTag?: string;
}): Promise<CodexAcpDepData> {
    const primaryBinPath = codexAcpBinPath();
    const state = await readCodexAcpState();
    const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;

    const installed = await (async () => {
        try {
            await access(primaryBinPath, accessMode);
            return true;
        } catch {
            return false;
        }
    })();

    const binPath = installed ? primaryBinPath : null;
    const installDir = codexAcpInstallDir();
    const installedVersion = await readInstalledNpmPackageVersion({ installDir, packageName: CODEX_ACP_NPM_PACKAGE });
    const includeRegistry = Boolean(opts?.includeRegistry);
    const onlyIfInstalled = Boolean(opts?.onlyIfInstalled);
    const distTag = typeof opts?.distTag === 'string' && opts.distTag.trim() ? opts.distTag.trim() : CODEX_ACP_DIST_TAG;

    const registry = includeRegistry && (!onlyIfInstalled || installed)
        ? await (async () => {
            try {
                const latestVersion = await readNpmDistTagVersion({ packageName: CODEX_ACP_NPM_PACKAGE, distTag });
                return { ok: true as const, latestVersion };
            } catch (e) {
                const msg = e instanceof Error ? e.message : 'Failed to read npm dist-tag';
                return { ok: false as const, errorMessage: msg };
            }
        })()
        : undefined;

    return {
        installed,
        binPath,
        installDir,
        installedVersion,
        distTag,
        lastInstallLogPath: state?.lastInstallLogPath ?? null,
        ...(registry ? { registry } : {}),
    };
}

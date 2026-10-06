import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol';

import { readSettings } from '@/persistence';
import { getBrowserChromiumArchiveDownloadInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/browserChromium';
import { resolveManagedBrowserSidecarCandidate } from './source';

export const BROWSER_SANDBOX_NEXT_ACTION = 'Run happier browser sandbox install on this machine to allow user namespaces for the managed Chromium executable.';

/** Only diagnose failed launches; an executable-scoped profile may allow Chrome while unshare stays denied. */
export async function isAppArmorUserNamespaceRestriction(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
        if ((await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim() !== '1') return false;
    } catch { return false; }
    return new Promise(resolve => {
        execFile('unshare', ['-Ur', 'true'], error => resolve(error !== null && error.code !== 'ENOENT'));
    });
}

export function managedChromiumAppArmorProfile(executablePath: string): Readonly<{ name: string; content: string }> {
    // AppArmor treats glob/brace characters as policy, even inside quotes. Admit literal paths only.
    if (!isAbsolute(executablePath) || /[\x00-\x1f\x7f"\\*?{}\[\]]/u.test(executablePath)) {
        throw new Error('Managed Chromium executable path cannot be represented as a literal AppArmor attachment.');
    }
    const name = `happier-managed-chromium-${createHash('sha256').update(executablePath).digest('hex')}`;
    // Ubuntu's documented per-program userns exception; Chromium retains its own namespace/seccomp sandbox.
    return { name, content: `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ${name} "${executablePath}" flags=(unconfined) {\n  userns,\n}\n` };
}

type SandboxInstallOptions = Readonly<{ interactive?: boolean; signal?: AbortSignal }>;
type SandboxInstallFailureCode = 'platform_unsupported' | 'managed_browser_unavailable' |
    'managed_browser_install_failed' | 'os_authorization_required' | 'sandbox_install_failed' | 'cancelled';
export type ManagedChromiumSandboxInstallResult = Readonly<
    { status: 'installed' } | { status: 'failed'; code: SandboxInstallFailureCode }
>;

class SandboxInstallError extends Error {
    constructor(readonly code: 'os_authorization_required' | 'sandbox_install_failed') {
        super(code);
    }
}

export async function installManagedChromiumAppArmorProfile(executablePath: string, options: SandboxInstallOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (process.platform !== 'linux') throw new Error('Browser sandbox installation is only needed on Linux with AppArmor.');
    const profile = managedChromiumAppArmorProfile(await realpath(executablePath));
    const scratch = await mkdtemp(join(tmpdir(), 'happier-browser-sandbox-'));
    try {
        const source = join(scratch, profile.name);
        await writeFile(source, profile.content, { mode: 0o600 });
        options.signal?.throwIfAborted();
        // One explicit sudo action. Only this profile is loaded; no service restart or sysctl write.
        await new Promise<void>((resolve, reject) => {
            const interactive = options.interactive !== false;
            const child = spawn('sudo', [...(interactive ? [] : ['-n']), '--', '/bin/sh', '-c',
                // Distinguish a privileged install/load failure from sudo refusing OS authorization.
                '(install -m 0644 -- "$1" "$2" && /usr/sbin/apparmor_parser -r -- "$2") || exit 42',
                'happier-browser-sandbox', source, `/etc/apparmor.d/${profile.name}`],
                { stdio: interactive ? 'inherit' : 'ignore', signal: options.signal });
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new SandboxInstallError(
                !interactive && code === 1 ? 'os_authorization_required' : 'sandbox_install_failed')));
        });
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

/** CLI and approved Action recovery share acquisition and the one narrow OS installer. */
export async function installManagedChromiumSandbox(options: SandboxInstallOptions = {}): Promise<ManagedChromiumSandboxInstallResult> {
    if (options.signal?.aborted) return { status: 'failed', code: 'cancelled' };
    if (process.platform !== 'linux') return { status: 'failed', code: 'platform_unsupported' };
    let stage: SandboxInstallFailureCode = 'managed_browser_unavailable';
    try {
        let candidate = await resolveManagedBrowserSidecarCandidate();
        options.signal?.throwIfAborted();
        if (candidate && !candidate.available) {
            stage = 'managed_browser_install_failed';
            const installed = await getBrowserChromiumArchiveDownloadInstallableAdapter().installOrUpgrade({ signal: options.signal });
            options.signal?.throwIfAborted();
            if (!installed.ok) return { status: 'failed', code: stage };
            candidate = await resolveManagedBrowserSidecarCandidate();
        }
        if (!candidate?.available || !candidate.executablePath) return { status: 'failed', code: 'managed_browser_unavailable' };
        stage = 'sandbox_install_failed';
        await installManagedChromiumAppArmorProfile(candidate.executablePath, options);
        options.signal?.throwIfAborted();
        return { status: 'installed' };
    } catch (error) {
        return { status: 'failed', code: options.signal?.aborted ? 'cancelled'
            : error instanceof SandboxInstallError ? error.code : stage };
    }
}

export async function executeManagedChromiumSandboxInstall(args: RuntimeActionExecuteArgs): Promise<unknown> {
    if (!args.context.authority) return { ok: false, errorCode: 'authority_required', error: 'authority_required' };
    const parsed = getActionSpec('browser.sandbox.install').inputSchema.safeParse(args.input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if (args.context.authority !== 'present_user' && !args.context.bypassApprovals) {
        return { ok: false, errorCode: 'approval_required', error: 'approval_required' };
    }
    let machineId: string | undefined;
    try { machineId = (await readSettings()).machineId; }
    catch { return { ok: false, errorCode: 'browser_machine_unavailable', error: 'browser_machine_unavailable' }; }
    const requested = parsed.data as Readonly<{ machineId: string }>;
    if (!machineId || requested.machineId !== machineId) {
        return { ok: false, errorCode: 'browser_machine_mismatch', error: 'browser_machine_mismatch' };
    }
    return installManagedChromiumSandbox({ interactive: false, signal: args.context.signal });
}

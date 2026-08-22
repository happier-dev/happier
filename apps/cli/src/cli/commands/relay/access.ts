import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { wantsJson, printJsonEnvelope } from "@/cli/output/jsonEnvelope";
import { buildSshCommand, safeBashSingleQuote, type SshAuth } from '@/capabilities/systemTasks/ssh/sshTransport';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { resolveHappyHomeDirFromEnvironment } from "@happier-dev/cli-common/agents";
import { definitionList, ok, renderHelpPage, sectionTitle, warn } from "@happier-dev/cli-common/output";
import {
    getRelayAccessProvider,
    relayAccessProviderIds,
    normalizeRelayAccessCanonicalPublicServerUrl,
    resolveRelayAccessConfiguredCanonicalPublicServerUrl,
} from "@happier-dev/cli-common/relayAccess";
import type { RelayAccessConfig, RelayAccessExecutionContext, RelayAccessProviderId } from "@happier-dev/cli-common/relayAccess";
import { readKnownHostsTextSync, sshKeyscanSync, writeKnownHostsTextSync } from '@happier-dev/cli-common/ssh';
import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import { getActiveServerProfile, upsertServerProfileByUrl } from '@/server/serverProfiles';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';
import { reloadConfiguration } from '@/configuration';
import { defaultWebappUrlFromServerUrl } from '../server/commandUtilities';
import { runServerSelectionBackgroundServiceFollowUp } from '../backgroundServiceFollowUp';

type RelayAccessJsonResult = Readonly<{
    configured: boolean;
    providerId: RelayAccessProviderId | null;
    shareUrl: string | null;
    state: string;
}>;

export function showRelayAccessHelp(): void {
    console.log(renderHelpPage({
        title: 'happier relay access',
        subtitle: 'Relay share URL configuration',
        usage: [
            { label: 'happier relay access status [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Show configured method + current share URL (if available)' },
            { label: 'happier relay access configure --provider <provider-id> [--upstream-url <url>] [--url <url>] [--hostname <hostname>] [--token <token>] [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Configure share URL strategy' },
            { label: 'happier relay access disable [--ssh <user@host>] [--ssh-port <number>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--yes] [--json]', description: 'Disable share URL strategy (remove persisted config)' },
        ],
        notes: [
            'Providers: localOnly, tailscaleServe, tailscaleFunnel, lan, cloudflareNamed',
            'When configuring tailscale/cloudflare, the share URL may require completing provider setup on the host before it becomes available.',
            'When a local provider returns a share URL, the active local relay profile adopts it while retaining its local upstream URL; disabling the provider restores that local URL.',
            'When using --ssh, Happier manages an app-scoped known_hosts file (StrictHostKeyChecking=yes). Use --yes to auto-accept host trust prompts in non-interactive runs.',
        ],
    }));
}

function relayAccessTargetToJson(target: systemTasks.RelayAccessTaskTarget): SystemTaskJsonObject {
    if (target.kind === 'local') {
        return { kind: 'local' };
    }

    const ssh = target.ssh;
    return {
        kind: 'ssh',
        ssh: {
            target: ssh.target,
            auth: ssh.auth,
            ...(typeof ssh.port === 'number' ? { port: ssh.port } : {}),
            ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}),
            ...(ssh.sshConfigFile ? { sshConfigFile: ssh.sshConfigFile } : {}),
            ...(ssh.knownHostsPath ? { knownHostsPath: ssh.knownHostsPath } : {}),
        },
    };
}

function takeFlag(args: string[], flag: string): Readonly<{ present: boolean; rest: string[] }> {
    const rest: string[] = [];
    let present = false;

    for (const current of args) {
        if (current === flag) {
            present = true;
            continue;
        }
        rest.push(current);
    }

    return { present, rest };
}

function takeFlagValue(args: string[], flag: string): Readonly<{ value: string | null; rest: string[] }> {
    const rest: string[] = [];
    let value: string | null = null;

    for (let index = 0; index < args.length; index += 1) {
        const current = String(args[index] ?? '');
        if (current === flag) {
            const next = String(args[index + 1] ?? '');
            if (!next || next.startsWith('--')) {
                throw new Error(`Missing value for ${flag}`);
            }
            value = next;
            index += 1;
            continue;
        }
        if (current.startsWith(`${flag}=`)) {
            const next = current.slice(`${flag}=`.length);
            if (!next) {
                throw new Error(`Missing value for ${flag}`);
            }
            value = next;
            continue;
        }
        rest.push(current);
    }

    return { value, rest };
}

function resolveConfigPath(): Readonly<{ dir: string; path: string }> {
    const home = resolveHappyHomeDirFromEnvironment(process.env);
    const dir = join(home, "relay", "access");
    return { dir, path: join(dir, "local.json") };
}

function normalizeProviderId(value: string | null): RelayAccessProviderId {
    const raw = String(value ?? "").trim();
    if (!raw) {
        throw new Error('Missing required flag: --provider');
    }
    if ((relayAccessProviderIds as readonly string[]).includes(raw)) {
        return raw as RelayAccessProviderId;
    }
    throw new Error(`Invalid relay access provider: ${raw}`);
}

function ensureNonEmptyString(value: string | null, label: string): string {
    const text = String(value ?? "").trim();
    if (!text) throw new Error(`Missing required flag: ${label}`);
    if (text.includes("\n") || text.includes("\r")) {
        throw new Error(`Invalid ${label}: expected a single line`);
    }
    return text;
}

function ensureCanonicalHttpUrl(value: string | null, label: string): string {
    const normalized = normalizeRelayAccessCanonicalPublicServerUrl(value);
    if (!normalized) {
        throw new Error(`Invalid ${label}: expected an http(s) URL`);
    }
    return normalized;
}

function resolveActiveLocalRelayUrl(active: Awaited<ReturnType<typeof getActiveServerProfile>> | null): string | null {
    if (!active || active.id === 'cloud') return null;
    if (active.localServerUrl && isLocalishServerUrl(active.localServerUrl)) return active.localServerUrl;
    return isLocalishServerUrl(active.serverUrl) ? active.serverUrl : null;
}

async function resolveRelayAccessUpstreamUrl(explicitValue: string | null): Promise<string> {
    if (explicitValue) {
        return ensureCanonicalHttpUrl(explicitValue, '--upstream-url');
    }

    const activeProfile = await getActiveServerProfile().catch(() => null);
    const localRelayUrl = resolveActiveLocalRelayUrl(activeProfile);
    if (localRelayUrl) {
        return ensureCanonicalHttpUrl(localRelayUrl, 'active relay local URL');
    }

    throw new Error('Missing required upstream URL: pass --upstream-url <url> or activate a server profile with a local URL.');
}

async function adoptLocalRelayAccessShareUrl(shareUrl: string): Promise<boolean> {
    const active = await getActiveServerProfile().catch(() => null);
    const localServerUrl = resolveActiveLocalRelayUrl(active);
    if (!active) return false;
    if (!localServerUrl || active.serverUrl === shareUrl) return false;

    await upsertServerProfileByUrl({
        name: active.name,
        serverUrl: shareUrl,
        localServerUrl,
        webappUrl: defaultWebappUrlFromServerUrl(shareUrl),
        use: true,
    });
    reloadConfiguration();
    return true;
}

async function resolveLocalRelayAccessProfileRevert(): Promise<Readonly<{
    active: Awaited<ReturnType<typeof getActiveServerProfile>>;
    localServerUrl: string;
}> | null> {
    const active = await getActiveServerProfile().catch(() => null);
    const localServerUrl = resolveActiveLocalRelayUrl(active);
    if (!active || !localServerUrl) return null;

    const configuredShareUrl = await resolveRelayAccessConfiguredCanonicalPublicServerUrl(process.env, {
        upstreamUrl: localServerUrl,
    });
    if (!configuredShareUrl) return null;
    if (
        normalizeRelayAccessCanonicalPublicServerUrl(active.serverUrl)
        !== normalizeRelayAccessCanonicalPublicServerUrl(configuredShareUrl)
    ) {
        return null;
    }
    return { active, localServerUrl };
}

async function revertLocalRelayAccessProfile(params: Readonly<{
    active: Awaited<ReturnType<typeof getActiveServerProfile>>;
    localServerUrl: string;
}>): Promise<void> {
    await upsertServerProfileByUrl({
        name: params.active.name,
        serverUrl: params.localServerUrl,
        localServerUrl: params.localServerUrl,
        webappUrl: defaultWebappUrlFromServerUrl(params.localServerUrl),
        use: true,
    });
    reloadConfiguration();
}

function parseConfigFromArgs(providerId: RelayAccessProviderId, args: string[]): RelayAccessConfig {
    if (providerId === "lan") {
        const url = takeFlagValue(args, "--url");
        const rest = url.rest;
        if (rest.length > 0) {
            throw new Error(`Unknown relay access configure arguments: ${rest.join(' ')}`);
        }
        return { providerId: "lan", url: ensureNonEmptyString(url.value, "--url") };
    }

    if (providerId === "cloudflareNamed") {
        const hostname = takeFlagValue(args, "--hostname");
        const token = takeFlagValue(hostname.rest, "--token");
        const rest = token.rest;
        if (rest.length > 0) {
            throw new Error(`Unknown relay access configure arguments: ${rest.join(' ')}`);
        }
        return {
            providerId: "cloudflareNamed",
            hostname: ensureNonEmptyString(hostname.value, "--hostname"),
            token: ensureNonEmptyString(token.value, "--token"),
        };
    }

    if (args.length > 0) {
        throw new Error(`Unknown relay access configure arguments: ${args.join(' ')}`);
    }
    return { providerId };
}

function parsePersistedConfigFromJson(raw: string): RelayAccessConfig | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
    if (!providerId) return null;

    if (providerId === "localOnly") {
        return { providerId: "localOnly" };
    }
    if (providerId === "tailscaleServe") {
        return { providerId: "tailscaleServe" };
    }
    if (providerId === "tailscaleFunnel") {
        return { providerId: "tailscaleFunnel" };
    }
    if (providerId === "lan") {
        const url = typeof record.url === "string" ? record.url.trim() : "";
        return url ? { providerId: "lan", url } : null;
    }
    if (providerId === "cloudflareNamed") {
        const hostname = typeof record.hostname === "string" ? record.hostname.trim() : "";
        const token = typeof record.token === "string" ? record.token.trim() : "";
        return hostname && token ? { providerId: "cloudflareNamed", hostname, token } : null;
    }

    return null;
}

async function readPersistedConfig(): Promise<RelayAccessConfig | null> {
    const { path } = resolveConfigPath();
    const raw = await readFile(path, "utf8").catch(() => "");
    if (!raw.trim()) return null;
    return parsePersistedConfigFromJson(raw);
}

function normalizeRelayAccessSshAuthValue(value: string | null, identityFile: string | null): systemTasks.SystemTaskSshConnectionConfig['auth'] {
    const raw = String(value ?? '').trim();
    if (raw === 'agent' || raw === 'keyfile' || raw === 'password') {
        return raw;
    }
    if (!raw) {
        return identityFile ? 'keyfile' : 'agent';
    }
    throw new Error(`Invalid SSH auth mode: ${raw}`);
}

async function resolveRelayAccessSshPassword(sshTarget: string): Promise<string> {
    const envPassword = String(process.env.HAPPIER_SSH_PASSWORD ?? '').trim();
    if (envPassword) {
        return envPassword;
    }
    if (!isInteractiveTerminal()) {
        throw new Error('Password SSH auth requires an interactive terminal or HAPPIER_SSH_PASSWORD.');
    }
    return (await promptSecret(`SSH password for ${sshTarget}: `)).trim();
}

async function resolveRelayAccessSshTarget(args: string[]): Promise<Readonly<{ target: systemTasks.RelayAccessTaskTarget; rest: string[] }>> {
    let rest = [...args];
    const ssh = takeFlagValue(rest, '--ssh');
    rest = ssh.rest;
    const sshPort = takeFlagValue(rest, '--ssh-port');
    rest = sshPort.rest;
    const sshConfigFile = takeFlagValue(rest, '--ssh-config-file');
    rest = sshConfigFile.rest;
    const sshAuth = takeFlagValue(rest, '--ssh-auth');
    rest = sshAuth.rest;
    const identityFile = takeFlagValue(rest, '--identity-file');
    rest = identityFile.rest;
    const knownHostsPath = takeFlagValue(rest, '--known-hosts-path');
    rest = knownHostsPath.rest;
    const trustedHostKey = takeFlagValue(rest, '--trusted-host-key');
    rest = trustedHostKey.rest;

    if (!ssh.value && (sshPort.value || sshConfigFile.value || sshAuth.value || identityFile.value || knownHostsPath.value || trustedHostKey.value)) {
        throw new Error('Missing required flag: --ssh (when using SSH-specific options).');
    }

    if (!ssh.value) {
        return {
            target: { kind: 'local' },
            rest,
        };
    }

    const normalizedTrustedHostKey = trustedHostKey.value?.trim() ?? '';
    if (normalizedTrustedHostKey && (normalizedTrustedHostKey.includes('\n') || normalizedTrustedHostKey.includes('\r'))) {
        throw new Error('Invalid --trusted-host-key: expected a single known_hosts line');
    }

    const auth = normalizeRelayAccessSshAuthValue(sshAuth.value, identityFile.value);
    const sshTarget = ensureNonEmptyString(ssh.value, '--ssh');
    const port = (() => {
        const raw = String(sshPort.value ?? '').trim();
        if (!raw) return null;
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new Error('Missing or invalid value for --ssh-port');
        }
        return parsed;
    })();
    const normalizedTarget: systemTasks.SystemTaskSshConnectionConfig = {
        target: sshTarget,
        auth,
        ...(typeof port === 'number' ? { port } : {}),
        ...(sshConfigFile.value?.trim() ? { sshConfigFile: sshConfigFile.value.trim() } : {}),
        ...(identityFile.value?.trim() ? { identityFile: identityFile.value.trim() } : {}),
        ...(knownHostsPath.value?.trim() ? { knownHostsPath: knownHostsPath.value.trim() } : {}),
        ...(normalizedTrustedHostKey ? { trustedHostKey: normalizedTrustedHostKey } : {}),
    };

    if (normalizedTrustedHostKey && !normalizedTarget.knownHostsPath) {
        throw new Error('Missing required flag: --known-hosts-path (when using --trusted-host-key).');
    }

    return {
        target: {
            kind: 'ssh',
            ssh: normalizedTarget,
        },
        rest,
    };
}

async function resolveRelayAccessSshAuth(ssh: systemTasks.SystemTaskSshConnectionConfig): Promise<SshAuth> {
    if (ssh.auth === 'agent') {
        return { mode: 'agent' };
    }
    if (ssh.auth === 'keyfile') {
        const identityFile = String(ssh.identityFile ?? '').trim();
        if (!identityFile) {
            throw new Error('SSH keyfile auth requires an identity file.');
        }
        return { mode: 'keyFile', privateKeyPath: identityFile };
    }
    const password = await resolveRelayAccessSshPassword(ssh.target);
    return { mode: 'password', password };
}

type RelayAccessSshRunner = Readonly<{
    runRemoteText: (remoteCommand: string) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
}>;

function formatSshHostTrustMessage(params: Readonly<{
    promptKind: 'ssh.trustHost' | 'ssh.replaceHostKey';
    host: string;
    keyType: string;
    fingerprint: string;
    existingFingerprint?: string;
}>): string {
    return [
        params.promptKind === 'ssh.replaceHostKey' ? 'SSH host key has changed.' : 'Trust remote SSH host key?',
        params.host ? `Host: ${params.host}` : '',
        params.keyType ? `Key type: ${params.keyType}` : '',
        params.fingerprint ? `Fingerprint: ${params.fingerprint}` : '',
        params.existingFingerprint ? `Existing fingerprint: ${params.existingFingerprint}` : '',
    ].filter(Boolean).join('\n');
}

function createRelayAccessSshRunner(params: Readonly<{
    ssh: systemTasks.SystemTaskSshConnectionConfig;
    auth: SshAuth;
    assumeYes: boolean;
    interactive: boolean;
}>): RelayAccessSshRunner {
    const ssh = params.ssh;
    const knownHostsPath = String(ssh.knownHostsPath ?? '').trim();
    const knownHostsMode: 'app' | 'system' = knownHostsPath ? 'app' : 'system';

    const ensureTrustedHostKey = () => {
        if (knownHostsMode !== 'app') return;
        const trustedHostKey = String(ssh.trustedHostKey ?? '').trim();
        if (!trustedHostKey) return;
        const existing = readKnownHostsTextSync(knownHostsPath);
        if (existing.includes(trustedHostKey)) return;
        const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        writeKnownHostsTextSync(knownHostsPath, `${existing}${suffix}${trustedHostKey}`);
    };

    function resolveSshEndpointForKeyscan(): Readonly<{ host: string; port?: number }> {
        const parsedTarget = systemTasks.parseSshTarget(ssh.target);
        const explicitPort = typeof ssh.port === 'number' && Number.isFinite(ssh.port) && ssh.port > 0
            ? Math.floor(ssh.port)
            : undefined;
        const baselinePort = explicitPort;

        const sshConfigFile = String(ssh.sshConfigFile ?? '').trim();
        if (!sshConfigFile) {
            return {
                host: parsedTarget.host,
                ...(typeof baselinePort === 'number' ? { port: baselinePort } : {}),
            };
        }

        const result = spawnSync('ssh', ['-G', '-F', sshConfigFile, ssh.target], { encoding: 'utf8', windowsHide: true });
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            const stderr = String(result.stderr ?? '').trim();
            const stdout = String(result.stdout ?? '').trim();
            const detail = stderr || stdout;
            throw new Error(detail ? `SSH config resolution failed: ${detail}` : 'SSH config resolution failed');
        }

        const values = new Map<string, string>();
        for (const line of String(result.stdout ?? '').split(/\r?\n/u)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const splitIndex = trimmed.indexOf(' ');
            if (splitIndex < 0) continue;
            const key = trimmed.slice(0, splitIndex).trim().toLowerCase();
            const value = trimmed.slice(splitIndex + 1).trim();
            if (key && value) {
                values.set(key, value);
            }
        }

        const resolvedPort = Number(values.get('port') ?? '');
        return {
            host: values.get('hostname')?.trim() || parsedTarget.host,
            ...(explicitPort
                ? { port: explicitPort }
                : (Number.isFinite(resolvedPort) && resolvedPort > 0
                    ? { port: Math.floor(resolvedPort) }
                    : (typeof baselinePort === 'number' ? { port: baselinePort } : {}))),
        };
    }

    const ensureHostTrusted = (() => {
        let resolved = false;
        return async () => {
            if (resolved) return;
            if (knownHostsMode !== 'app') {
                resolved = true;
                return;
            }
            if (ssh.trustedHostKey) {
                ensureTrustedHostKey();
                resolved = true;
                return;
            }

            const parsedTarget = systemTasks.parseSshTarget(ssh.target);
            const host = parsedTarget.host.trim();
            if (!host) {
                throw new Error('Missing required SSH host.');
            }

            const endpoint = resolveSshEndpointForKeyscan();
            const scannedOutput = sshKeyscanSync({
                host: endpoint.host,
                ...(typeof endpoint.port === 'number' ? { port: endpoint.port } : {}),
                timeoutSec: 10,
            });
            const scanned = systemTasks.extractFirstScannedSshKnownHostLine(scannedOutput);
            const trust = systemTasks.resolveSshKnownHostTrust({
                knownHostsText: readKnownHostsTextSync(knownHostsPath),
                scannedHostKeyLine: scanned.line,
            });

            if (trust.status === 'rejected') {
                throw new Error(trust.message);
            }

            if (trust.status === 'prompt') {
                if (!params.assumeYes) {
                    if (!params.interactive) {
                        throw new Error('Non-interactive mode requires --yes for SSH host trust prompts.');
                    }
                    const message = formatSshHostTrustMessage({
                        promptKind: trust.promptKind,
                        host: trust.scanned.host,
                        keyType: trust.scanned.keyType,
                        fingerprint: trust.scanned.fingerprint,
                        ...(trust.existingFingerprint ? { existingFingerprint: trust.existingFingerprint } : {}),
                    });
                    const answer = await promptInput(`${message}\nTrust this host key? [y/N]: `);
                    if (!/^y(?:es)?$/i.test(answer.trim())) {
                        throw new Error('SSH host trust was declined.');
                    }
                }

                writeKnownHostsTextSync(knownHostsPath, trust.nextKnownHostsText);
                resolved = true;
                return;
            }

            writeKnownHostsTextSync(knownHostsPath, trust.nextKnownHostsText);
            resolved = true;
        };
    })();

    return {
        runRemoteText: async (remoteCommand: string) => {
            await ensureHostTrusted();
            const { command, args, env } = buildSshCommand({
                sshBin: 'ssh',
                target: ssh.target,
                remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
                knownHostsMode,
                ...(knownHostsMode === 'app' ? { knownHostsPath } : {}),
                auth: params.auth,
                port: ssh.port,
                connectTimeoutSec: 10,
                serverAliveIntervalSec: 15,
                serverAliveCountMax: 3,
                ...(ssh.sshConfigFile ? { sshConfigFile: ssh.sshConfigFile } : {}),
            });

            const out = spawnSync(command, args, { encoding: 'utf8', ...(env ? { env } : {}) });
            return {
                status: typeof out.status === 'number' ? out.status : 1,
                stdout: String(out.stdout ?? ''),
                stderr: String(out.stderr ?? out.error?.message ?? ''),
            };
        },
    };
}

async function runSshCapture(
    runner: RelayAccessSshRunner,
    remoteCommand: string,
): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
    return runner.runRemoteText(remoteCommand);
}

async function readRelayAccessConfig(params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; runner?: RelayAccessSshRunner }>): Promise<RelayAccessConfig | null> {
    if (params.target.kind === 'ssh') {
        if (!params.runner) {
            throw new Error('Missing SSH runner for relay access config read');
        }
        const result = await runSshCapture(
            params.runner,
            "test -f ~/.happier/relay/access/local.json && cat ~/.happier/relay/access/local.json || true",
        );
        if (result.status !== 0) {
            throw new Error(result.stderr.trim() || 'SSH command failed');
        }
        const raw = result.stdout.trim();
        if (!raw) return null;
        return parsePersistedConfigFromJson(raw);
    }

    return await readPersistedConfig();
}

async function writeRelayAccessConfig(params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; config: RelayAccessConfig | null; runner?: RelayAccessSshRunner }>): Promise<void> {
    if (params.target.kind === 'ssh') {
        if (!params.runner) {
            throw new Error('Missing SSH runner for relay access config write');
        }
        if (!params.config) {
            const result = await runSshCapture(
                params.runner,
                'rm -f ~/.happier/relay/access/local.json',
            );
            if (result.status !== 0) {
                throw new Error(result.stderr.trim() || 'SSH command failed');
            }
            return;
        }

        const payload = `${JSON.stringify(params.config, null, 2)}\n`;
        const remoteCommand = [
            'mkdir -p ~/.happier/relay/access',
            'chmod 700 ~/.happier/relay/access || true',
            "cat > ~/.happier/relay/access/local.json <<'HAPPIER_RELAY_ACCESS_EOF'",
            payload.trimEnd(),
            'HAPPIER_RELAY_ACCESS_EOF',
            'chmod 600 ~/.happier/relay/access/local.json || true',
        ].join('\n');
        const result = await runSshCapture(
            params.runner,
            remoteCommand,
        );
        if (result.status !== 0) {
            throw new Error(result.stderr.trim() || 'SSH command failed');
        }
        return;
    }

    const { dir, path } = resolveConfigPath();
    if (!params.config) {
        await rm(path, { force: true });
        return;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(params.config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
}

function createRelayAccessExecutionContext(params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; upstreamUrl: string | null; runner?: RelayAccessSshRunner }>): RelayAccessExecutionContext {
    if (params.target.kind !== 'ssh') {
        return {
            env: process.env,
            upstreamUrl: params.upstreamUrl ?? null,
        };
    }

    const ssh = params.target.ssh;

    return {
        env: {},
        upstreamUrl: params.upstreamUrl ?? null,
        runCommand: async (request) => {
            const command = String(request.command ?? '').trim();
            const args = Array.isArray(request.args) ? request.args.map((value) => String(value)) : [];
            const shellCommand = [command, ...args].map((token) => safeBashSingleQuote(token)).join(' ');
            if (!params.runner) {
                throw new Error('Missing SSH runner for relay access remote execution');
            }
            const result = await runSshCapture(params.runner, shellCommand);
            const exitCode = result.status;
            if (exitCode !== 0) {
                throw new Error(result.stderr.trim() || `Remote command failed: ${command}`);
            }
            return {
                command,
                args,
                exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            };
        },
        resolveCommandOnPath: async (command) => {
            const name = String(command ?? '').trim();
            if (!name) return null;
            if (!params.runner) {
                throw new Error('Missing SSH runner for relay access remote resolution');
            }
            const result = await runSshCapture(
                params.runner,
                `command -v ${safeBashSingleQuote(name)} || true`,
            );
            if (result.status !== 0) return null;
            const resolved = result.stdout.trim().split(/\r?\n/u)[0]?.trim() ?? '';
            return resolved || null;
        },
    };
}

async function cmdStatus(args: string[]): Promise<void> {
    let rest = [...args];
    const jsonFlag = takeFlag(rest, '--json');
    rest = jsonFlag.rest;
    const yesFlag = takeFlag(rest, '--yes');
    rest = yesFlag.rest;
    const assumeYes = yesFlag.present;
    const json = jsonFlag.present || wantsJson(args);
    const resolvedTarget = await resolveRelayAccessSshTarget(rest);
    const target = resolvedTarget.target;
    rest = resolvedTarget.rest;
    if (rest.length > 0) {
        throw new Error(`Unknown relay access status arguments: ${rest.join(' ')}`);
    }
    const sshAuth = target.kind === 'ssh' ? await resolveRelayAccessSshAuth(target.ssh) : null;
    const sshRunner = target.kind === 'ssh'
        ? createRelayAccessSshRunner({ ssh: target.ssh, auth: sshAuth ?? { mode: 'agent' }, assumeYes, interactive: isInteractiveTerminal() })
        : null;

    let capturedConfig: RelayAccessConfig | null = null;
    const kind = systemTasks.createRelayAccessStatusTaskKind({
        readConfig: async (params) => {
            capturedConfig = await readRelayAccessConfig({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) });
            return capturedConfig;
        },
        getProvider: (providerId) => getRelayAccessProvider(providerId),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) }),
    });

    const snapshot = await kind.run({
        params: { target: relayAccessTargetToJson(target) },
        emit: () => {},
        prompt: async () => {
            throw new Error('Relay access status should not prompt.');
        },
    });

    if (!snapshot.configured) {
        const payload: RelayAccessJsonResult = { configured: false, providerId: null, shareUrl: null, state: "disabled" };
        if (json) {
            await printJsonEnvelope({ ok: true, kind: "relay_access_status", data: payload });
            return;
        }
        console.log(sectionTitle("Relay access"));
        console.log(warn("No relay access method configured."));
        return;
    }

    const payload: RelayAccessJsonResult = {
        configured: snapshot.configured,
        providerId: snapshot.providerId,
        shareUrl: snapshot.status.shareUrl,
        state: snapshot.status.state,
    };
    if (json) {
        await printJsonEnvelope({
            ok: true,
            kind: "relay_access_status",
            data: {
                ...payload,
                ...(capturedConfig ? { config: systemTasks.redactSensitiveSystemTaskJsonValue(capturedConfig) } : {}),
                ...(snapshot.status.details ? { details: snapshot.status.details } : {}),
            },
        });
        return;
    }

    console.log(sectionTitle("Relay access"));
    console.log(definitionList(
        [
            { label: "Method", value: snapshot.providerId ?? '' },
            { label: "State", value: snapshot.status.state },
            ...(snapshot.status.shareUrl ? [{ label: "Share URL", value: snapshot.status.shareUrl }] : []),
        ],
        { indent: "  " },
    ));
}

async function cmdConfigure(args: string[]): Promise<void> {
    let rest = [...args];
    const jsonFlag = takeFlag(rest, '--json');
    rest = jsonFlag.rest;
    const yesFlag = takeFlag(rest, '--yes');
    rest = yesFlag.rest;
    const assumeYes = yesFlag.present;
    const json = jsonFlag.present || wantsJson(args);
    const resolvedTarget = await resolveRelayAccessSshTarget(rest);
    const target = resolvedTarget.target;
    rest = resolvedTarget.rest;
    const sshAuth = target.kind === 'ssh' ? await resolveRelayAccessSshAuth(target.ssh) : null;
    const sshRunner = target.kind === 'ssh'
        ? createRelayAccessSshRunner({ ssh: target.ssh, auth: sshAuth ?? { mode: 'agent' }, assumeYes, interactive: isInteractiveTerminal() })
        : null;

    const upstream = takeFlagValue(rest, '--upstream-url');
    rest = upstream.rest;
    const provider = takeFlagValue(rest, "--provider");
    rest = provider.rest;
    const providerId = normalizeProviderId(provider.value);

    const upstreamUrl = providerId === 'tailscaleServe' || providerId === 'tailscaleFunnel'
        ? await resolveRelayAccessUpstreamUrl(upstream.value)
        : null;

    const config = parseConfigFromArgs(providerId, rest);

    let capturedConfig: RelayAccessConfig | null = null;
    const kind = systemTasks.createRelayAccessConfigureTaskKind({
        writeConfig: async (params) => {
            capturedConfig = params.config;
            await writeRelayAccessConfig({ target: params.target, config: params.config, ...(sshRunner ? { runner: sshRunner } : {}) });
        },
        getProvider: (providerIdInner) => getRelayAccessProvider(providerIdInner),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) }),
    });

    const snapshot = await kind.run({
        params: {
            target: relayAccessTargetToJson(target),
            upstreamUrl,
            providerId,
            config,
        },
        emit: () => {},
        prompt: async () => {
            throw new Error('Relay access configure should not prompt.');
        },
    });

    const payload: RelayAccessJsonResult = {
        configured: snapshot.configured,
        providerId: snapshot.providerId,
        shareUrl: snapshot.status.shareUrl,
        state: snapshot.status.state,
    };

    const adoptedShareUrl = target.kind === 'local' && payload.shareUrl
        ? await adoptLocalRelayAccessShareUrl(payload.shareUrl)
        : false;

    if (json) {
        await printJsonEnvelope({
            ok: true,
            kind: "relay_access_configure",
            data: {
                ...payload,
                ...(capturedConfig ? { config: systemTasks.redactSensitiveSystemTaskJsonValue(capturedConfig) } : {}),
                ...(snapshot.status.details ? { details: snapshot.status.details } : {}),
            },
        });
        return;
    }

    console.log(ok(`Saved relay access method: ${providerId}`));
    if (snapshot.status.shareUrl) {
        console.log(`  ${snapshot.status.shareUrl}`);
    } else {
        console.log(warn("Share URL not available yet. Complete the required setup and retry `happier relay access status`."));
    }

    if (adoptedShareUrl && payload.shareUrl) {
        await runServerSelectionBackgroundServiceFollowUp({
            interactive: isInteractiveTerminal(),
            targetServerUrl: payload.shareUrl,
        });
    }
}

async function cmdDisable(args: string[]): Promise<void> {
    let rest = [...args];
    const jsonFlag = takeFlag(rest, '--json');
    rest = jsonFlag.rest;
    const yesFlag = takeFlag(rest, '--yes');
    rest = yesFlag.rest;
    const assumeYes = yesFlag.present;
    const json = jsonFlag.present || wantsJson(args);
    const resolvedTarget = await resolveRelayAccessSshTarget(rest);
    const target = resolvedTarget.target;
    rest = resolvedTarget.rest;
    const sshAuth = target.kind === 'ssh' ? await resolveRelayAccessSshAuth(target.ssh) : null;
    const sshRunner = target.kind === 'ssh'
        ? createRelayAccessSshRunner({ ssh: target.ssh, auth: sshAuth ?? { mode: 'agent' }, assumeYes, interactive: isInteractiveTerminal() })
        : null;
    if (rest.length > 0) {
        throw new Error(`Unknown relay access disable arguments: ${rest.join(' ')}`);
    }

    // Resolve this before the provider config is removed. Only a profile still
    // pointing at that provider's own share URL is eligible for reversion; a
    // profile the user changed independently must remain untouched.
    const profileRevert = target.kind === 'local'
        ? await resolveLocalRelayAccessProfileRevert()
        : null;

    const kind = systemTasks.createRelayAccessDisableTaskKind({
        readConfig: async (params) => await readRelayAccessConfig({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) }),
        writeConfig: async (params) => {
            await writeRelayAccessConfig({ target: params.target, config: params.config, ...(sshRunner ? { runner: sshRunner } : {}) });
        },
        getProvider: (providerId) => getRelayAccessProvider(providerId),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) }),
    });

    await kind.run({
        params: { target: relayAccessTargetToJson(target) },
        emit: () => {},
        prompt: async () => {
            throw new Error('Relay access disable should not prompt.');
        },
    });

    if (profileRevert) {
        await revertLocalRelayAccessProfile(profileRevert);
    }

    if (json) {
        const payload: RelayAccessJsonResult = { configured: false, providerId: null, shareUrl: null, state: "disabled" };
        await printJsonEnvelope({ ok: true, kind: "relay_access_disable", data: payload });
        return;
    }
    console.log(ok("Relay access disabled."));
    if (profileRevert) {
        await runServerSelectionBackgroundServiceFollowUp({
            interactive: isInteractiveTerminal(),
            targetServerUrl: profileRevert.localServerUrl,
        });
    }
}

export async function runRelayAccessSubcommand(args: string[]): Promise<boolean> {
    const sub = String(args[0] ?? "").trim();
    const wantsHelp = args.includes('--help') || args.includes('-h');
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h' || wantsHelp) {
        showRelayAccessHelp();
        process.exitCode = 0;
        return true;
    }

    const rest = args.slice(1);
    switch (sub) {
        case "status":
            await cmdStatus(rest);
            return true;
        case "configure":
            await cmdConfigure(rest);
            return true;
        case "disable":
            await cmdDisable(rest);
            return true;
        default:
            showRelayAccessHelp();
            throw new Error(`Unknown relay access subcommand: ${sub}`);
    }
}

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { wantsJson, printJsonEnvelope } from "@/cli/output/jsonEnvelope";
import { buildSshCommand, safeBashSingleQuote, type SshAuth } from '@/capabilities/systemTasks/ssh/sshTransport';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { resolveHappyHomeDirFromEnvironment } from "@happier-dev/cli-common/providers";
import { definitionList, ok, sectionTitle, warn } from "@happier-dev/cli-common/output";
import { getRelayAccessProvider, relayAccessProviderIds, normalizeRelayAccessCanonicalPublicServerUrl } from "@happier-dev/cli-common/relayAccess";
import type { RelayAccessConfig, RelayAccessExecutionContext, RelayAccessProviderId } from "@happier-dev/cli-common/relayAccess";
import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';

type RelayAccessJsonResult = Readonly<{
    configured: boolean;
    providerId: RelayAccessProviderId | null;
    shareUrl: string | null;
    state: string;
}>;

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

async function resolveRelayAccessUpstreamUrl(explicitValue: string | null): Promise<string> {
    if (explicitValue) {
        return ensureCanonicalHttpUrl(explicitValue, '--upstream-url');
    }

    const activeProfile = await getActiveServerProfile().catch(() => null);
    const localRelayUrl = activeProfile?.localServerUrl && isLocalishServerUrl(activeProfile.localServerUrl)
        ? activeProfile.localServerUrl
        : null;
    if (localRelayUrl) {
        return ensureCanonicalHttpUrl(localRelayUrl, 'active relay local URL');
    }

    throw new Error('Missing required upstream URL: pass --upstream-url <url> or activate a server profile with a local URL.');
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
    const sshConfigFile = takeFlagValue(rest, '--ssh-config-file');
    rest = sshConfigFile.rest;
    const sshAuth = takeFlagValue(rest, '--ssh-auth');
    rest = sshAuth.rest;
    const identityFile = takeFlagValue(rest, '--identity-file');
    rest = identityFile.rest;

    if (!ssh.value && (sshConfigFile.value || sshAuth.value || identityFile.value)) {
        throw new Error('Missing required flag: --ssh (when using SSH-specific options).');
    }

    if (!ssh.value) {
        return {
            target: { kind: 'local' },
            rest,
        };
    }

    const auth = normalizeRelayAccessSshAuthValue(sshAuth.value, identityFile.value);
    const sshTarget = ensureNonEmptyString(ssh.value, '--ssh');
    const normalizedTarget: systemTasks.SystemTaskSshConnectionConfig = {
        target: sshTarget,
        auth,
        ...(sshConfigFile.value?.trim() ? { sshConfigFile: sshConfigFile.value.trim() } : {}),
        ...(identityFile.value?.trim() ? { identityFile: identityFile.value.trim() } : {}),
    };

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

function runSshCapture(
    ssh: systemTasks.SystemTaskSshConnectionConfig,
    auth: SshAuth,
    remoteCommand: string,
): Readonly<{ status: number; stdout: string; stderr: string }> {
    const { command, args, env } = buildSshCommand({
        sshBin: 'ssh',
        target: ssh.target,
        remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
        knownHostsMode: 'system',
        auth,
        port: ssh.port,
        connectTimeoutSec: 10,
        serverAliveIntervalSec: 15,
        serverAliveCountMax: 3,
        ...(ssh.sshConfigFile ? { sshConfigFile: ssh.sshConfigFile } : {}),
        ...(ssh.knownHostsPath ? { knownHostsPath: ssh.knownHostsPath } : {}),
    });

    const out = spawnSync(command, args, { encoding: 'utf8', ...(env ? { env } : {}) });
    return {
        status: typeof out.status === 'number' ? out.status : 1,
        stdout: String(out.stdout ?? ''),
        stderr: String(out.stderr ?? out.error?.message ?? ''),
    };
}

async function readRelayAccessConfig(params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; auth?: SshAuth }>): Promise<RelayAccessConfig | null> {
    if (params.target.kind === 'ssh') {
        const result = runSshCapture(
            params.target.ssh,
            params.auth ?? await resolveRelayAccessSshAuth(params.target.ssh),
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

async function writeRelayAccessConfig(params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; config: RelayAccessConfig | null; auth?: SshAuth }>): Promise<void> {
    if (params.target.kind === 'ssh') {
        if (!params.config) {
            const result = runSshCapture(
                params.target.ssh,
                params.auth ?? await resolveRelayAccessSshAuth(params.target.ssh),
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
            "cat > ~/.happier/relay/access/local.json <<'HAPPIER_RELAY_ACCESS_EOF'",
            payload.trimEnd(),
            'HAPPIER_RELAY_ACCESS_EOF',
        ].join('\n');
        const result = runSshCapture(
            params.target.ssh,
            params.auth ?? await resolveRelayAccessSshAuth(params.target.ssh),
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
}

function createRelayAccessExecutionContext(params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; upstreamUrl: string | null; auth?: SshAuth }>): RelayAccessExecutionContext {
    if (params.target.kind !== 'ssh') {
        return {
            env: process.env,
            upstreamUrl: params.upstreamUrl ?? null,
        };
    }

    const ssh = params.target.ssh;

    return {
        env: process.env,
        upstreamUrl: params.upstreamUrl ?? null,
        runCommand: async (request) => {
            const command = String(request.command ?? '').trim();
            const args = Array.isArray(request.args) ? request.args.map((value) => String(value)) : [];
            const shellCommand = [command, ...args].map((token) => safeBashSingleQuote(token)).join(' ');
            const result = runSshCapture(ssh, params.auth ?? await resolveRelayAccessSshAuth(ssh), shellCommand);
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
            const result = runSshCapture(
                ssh,
                params.auth ?? await resolveRelayAccessSshAuth(ssh),
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
    const json = jsonFlag.present || wantsJson(args);
    const resolvedTarget = await resolveRelayAccessSshTarget(rest);
    const target = resolvedTarget.target;
    rest = resolvedTarget.rest;
    if (rest.length > 0) {
        throw new Error(`Unknown relay access status arguments: ${rest.join(' ')}`);
    }
    const sshAuth = target.kind === 'ssh' ? await resolveRelayAccessSshAuth(target.ssh) : null;

    let capturedConfig: RelayAccessConfig | null = null;
    const kind = systemTasks.createRelayAccessStatusTaskKind({
        readConfig: async (params) => {
            capturedConfig = await readRelayAccessConfig({ ...params, auth: sshAuth ?? undefined });
            return capturedConfig;
        },
        getProvider: (providerId) => getRelayAccessProvider(providerId),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, auth: sshAuth ?? undefined }),
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
            printJsonEnvelope({ ok: true, kind: "relay_access_status", data: payload });
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
        printJsonEnvelope({
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
    const json = jsonFlag.present || wantsJson(args);
    const resolvedTarget = await resolveRelayAccessSshTarget(rest);
    const target = resolvedTarget.target;
    rest = resolvedTarget.rest;
    const sshAuth = target.kind === 'ssh' ? await resolveRelayAccessSshAuth(target.ssh) : null;

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
            await writeRelayAccessConfig({ target: params.target, config: params.config, auth: sshAuth ?? undefined });
        },
        getProvider: (providerIdInner) => getRelayAccessProvider(providerIdInner),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, auth: sshAuth ?? undefined }),
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

    if (json) {
        printJsonEnvelope({
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
}

async function cmdDisable(args: string[]): Promise<void> {
    let rest = [...args];
    const jsonFlag = takeFlag(rest, '--json');
    rest = jsonFlag.rest;
    const json = jsonFlag.present || wantsJson(args);
    const resolvedTarget = await resolveRelayAccessSshTarget(rest);
    const target = resolvedTarget.target;
    rest = resolvedTarget.rest;
    const sshAuth = target.kind === 'ssh' ? await resolveRelayAccessSshAuth(target.ssh) : null;
    if (rest.length > 0) {
        throw new Error(`Unknown relay access disable arguments: ${rest.join(' ')}`);
    }

    const kind = systemTasks.createRelayAccessDisableTaskKind({
        readConfig: async (params) => await readRelayAccessConfig({ ...params, auth: sshAuth ?? undefined }),
        writeConfig: async (params) => {
            await writeRelayAccessConfig({ target: params.target, config: params.config, auth: sshAuth ?? undefined });
        },
        getProvider: (providerId) => getRelayAccessProvider(providerId),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, auth: sshAuth ?? undefined }),
    });

    await kind.run({
        params: { target: relayAccessTargetToJson(target) },
        emit: () => {},
        prompt: async () => {
            throw new Error('Relay access disable should not prompt.');
        },
    });

    if (json) {
        const payload: RelayAccessJsonResult = { configured: false, providerId: null, shareUrl: null, state: "disabled" };
        printJsonEnvelope({ ok: true, kind: "relay_access_disable", data: payload });
        return;
    }
    console.log(ok("Relay access disabled."));
}

export async function runRelayAccessSubcommand(args: string[]): Promise<boolean> {
    const sub = String(args[0] ?? "").trim();
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
            return false;
    }
}

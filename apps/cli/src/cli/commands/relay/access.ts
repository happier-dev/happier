import { readAvailableRelayAccessDescriptors, showRelayAccessHelp } from './accessHelp';
export { showRelayAccessHelp } from './accessHelp';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { wantsJson, printJsonEnvelope } from "@/cli/output/jsonEnvelope";
import { safeBashSingleQuote, type SshAuth } from '@/capabilities/systemTasks/ssh/sshTransport';
import { answerSshHostTrustPrompt } from '@/cli/commands/sshHostTrustPrompt';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { resolveHappyHomeDirFromEnvironment } from "@happier-dev/cli-common/agents";
import { definitionList, ok, renderHelpPage, sectionTitle, warn } from "@happier-dev/cli-common/output";
import {
    getRelayAccessProvider,
    getRelayAccessProviderDescriptor,
    parseRelayAccessConfig,
    relayAccessProviderDescriptors,
    normalizeRelayAccessCanonicalPublicServerUrl,
    resolveRelayAccessConfiguredCanonicalPublicServerUrl,
} from "@happier-dev/cli-common/relayAccess";
import type { RelayAccessConfig, RelayAccessExecutionContext, RelayAccessProviderId } from "@happier-dev/cli-common/relayAccess";
import {
    readKnownHostsTextSync,
    runOpenSshRemoteCommand,
    sshKeyscanSync,
    writeKnownHostsTextSync,
} from '@happier-dev/cli-common/ssh';
import * as systemTasks from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';
import type { ServerSelectionMutationMode } from '../backgroundServiceFollowUp';

type RelayAccessSubcommandOptions = Readonly<{
    selectionMutationMode?: ServerSelectionMutationMode;
}>;

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
    const raw = String(value ?? '').trim();
    if (!raw) throw new Error('Missing required flag: --provider');
    const descriptor = readAvailableRelayAccessDescriptors().find(candidate => candidate.id === raw);
    if (!descriptor) throw new Error('Invalid or unavailable relay access provider');
    return descriptor.id;
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

function parseConfigFromArgs(providerId: RelayAccessProviderId, args: string[]): RelayAccessConfig {
    const descriptor = getRelayAccessProviderDescriptor({ kind: 'builtin', id: providerId });
    const configArg = takeFlagValue(args, '--config');
    const refsArg = takeFlagValue(configArg.rest, '--credential-refs');
    let rest = refsArg.rest;
    const fields: Record<string, unknown> = {};
    const properties = descriptor.definition.configSchema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        for (const [name, schema] of Object.entries(properties)) {
            if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'string') continue;
            const field = takeFlagValue(rest, `--${name}`);
            rest = field.rest;
            if (field.value !== null) {
                if (configArg.value !== null) throw new Error('Use either --config or individual config fields');
                fields[name] = ensureNonEmptyString(field.value, `--${name}`);
            }
        }
    }
    // Never include unknown arguments: they may be obsolete raw credential flags.
    if (rest.length) throw new Error('Unknown relay access configure arguments');
    let config: unknown = fields;
    let credentialRefs: unknown = [];
    try {
        if (configArg.value !== null) config = JSON.parse(configArg.value);
        if (refsArg.value !== null) credentialRefs = JSON.parse(refsArg.value);
    } catch {
        throw new Error('Invalid relay access JSON');
    }
    const selection = parseRelayAccessConfig({ provider: descriptor.provider, config, credentialRefs });
    if (!selection) throw new Error('Invalid relay access selection');
    return selection;
}

function parsePersistedConfigFromJson(raw: string): RelayAccessConfig | null {
    try { return parseRelayAccessConfig(JSON.parse(raw), relayAccessProviderDescriptors.filter(descriptor =>
        descriptor.definition.targets.includes('homeRelay'))); }
    catch { return null; }
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
        writeKnownHostsTextSync(knownHostsPath, existing => {
            if (existing.includes(trustedHostKey)) return existing;
            const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
            return `${existing}${suffix}${trustedHostKey}`;
        });
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
                if (!params.assumeYes && !params.interactive) {
                    throw new Error('Non-interactive mode requires --yes for SSH host trust prompts.');
                }
                const answer = await answerSshHostTrustPrompt({
                    prompt: {
                        kind: trust.promptKind,
                        data: {
                            host: trust.scanned.host,
                            keyType: trust.scanned.keyType,
                            fingerprint: trust.scanned.fingerprint,
                            ...(trust.existingFingerprint ? { existingFingerprint: trust.existingFingerprint } : {}),
                        },
                    },
                    assumeYes: params.assumeYes,
                    interactive: params.interactive,
                    confirm: async (message) => /^y(?:es)?$/i.test(
                        (await promptInput(`${message}\nTrust this host key? [y/N]: `)).trim(),
                    ),
                });
                if (!answer.trusted) {
                    throw new Error('SSH host trust was declined.');
                }

                systemTasks.persistSshKnownHostTrust({ knownHostsPath, trust });
                resolved = true;
                return;
            }

            systemTasks.persistSshKnownHostTrust({ knownHostsPath, trust });
            resolved = true;
        };
    })();

    return {
        runRemoteText: async (remoteCommand: string) => {
            await ensureHostTrusted();
            return await runOpenSshRemoteCommand({
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
                rejectOnNonZero: false,
                errorPrefix: 'Relay access SSH command failed',
            });
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
        env: { NODE_ENV: process.env.NODE_ENV },
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

    const kind = systemTasks.createRelayAccessStatusTaskKind({
        readConfig: async (params) => await readRelayAccessConfig({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) }),
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
                ...(snapshot.selection ? { config: snapshot.selection } : {}),
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

    const config = parseConfigFromArgs(providerId, rest);
    const descriptor = getRelayAccessProviderDescriptor(config.provider);
    const upstreamUrl = descriptor.requiresUpstreamUrl
        ? await resolveRelayAccessUpstreamUrl(upstream.value)
        : null;
    const kind = systemTasks.createRelayAccessConfigureTaskKind({
        writeConfig: async (params) => {
            await writeRelayAccessConfig({ target: params.target, config: params.config, ...(sshRunner ? { runner: sshRunner } : {}) });
        },
        getProvider: (providerIdInner) => getRelayAccessProvider(providerIdInner),
        createExecutionContext: (params) => createRelayAccessExecutionContext({ ...params, ...(sshRunner ? { runner: sshRunner } : {}) }),
    });

    const snapshot = await kind.run({
        params: {
            target: relayAccessTargetToJson(target),
            upstreamUrl,
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
        await printJsonEnvelope({
            ok: true,
            kind: "relay_access_configure",
            data: {
                ...payload,
                ...(snapshot.selection ? { config: snapshot.selection } : {}),
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

    if (json) {
        const payload: RelayAccessJsonResult = { configured: false, providerId: null, shareUrl: null, state: "disabled" };
        await printJsonEnvelope({ ok: true, kind: "relay_access_disable", data: payload });
        return;
    }
    console.log(ok("Relay access disabled."));
}

export async function runRelayAccessSubcommand(
    args: string[],
    options: RelayAccessSubcommandOptions = {},
): Promise<boolean> {
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

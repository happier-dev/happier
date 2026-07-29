import type {
    PluginAgentCliMetadata,
    PluginAgentCliAuthProbeMetadata,
} from '@happier-dev/protocol';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';

import type { CliAuthSpec } from '@/capabilities/cliAuth/types';
import {
    readJsonFileSafe,
    resolveCommonApiKeyStatus,
    runCliCommandBestEffort,
} from '@/capabilities/cliAuth/shared';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import type { ResolvedCatalogEntry } from './types';

function readLocalizedTitle(title: unknown, fallback: string): string {
    if (typeof title === 'string' && title.trim().length > 0) return title.trim();
    if (title && typeof title === 'object' && !Array.isArray(title)) {
        const localizedFallback = Reflect.get(title, 'fallback');
        if (typeof localizedFallback === 'string' && localizedFallback.trim().length > 0) {
            return localizedFallback.trim();
        }
    }
    return fallback;
}

export function projectNativeAgentCliRuntimeDescriptor(params: Readonly<{
    agentId: string;
    title: unknown;
    cli: PluginAgentCliMetadata;
}>): AgentCliRuntimeDescriptor {
    const { executable, install } = params.cli;
    const manualInstallRecipes = install.manual.kind === 'none'
        ? null
        : (install.manual.recipes ?? null);
    return Object.freeze({
        id: params.agentId,
        title: params.cli.displayName ?? readLocalizedTitle(params.title, params.agentId),
        binaryName: executable.binaryName,
        ...(executable.alternativeBinaryNames
            ? { alternativeBinaryNames: Object.freeze([...executable.alternativeBinaryNames]) }
            : {}),
        ...(executable.alternativeBinaryFallbackEnabledEnvVar
            ? { alternativeBinaryFallbackEnabledEnvVar: executable.alternativeBinaryFallbackEnabledEnvVar }
            : {}),
        ...(executable.knownUserBinDirSuffixes === null
            ? { knownUserBinDirSuffixes: null }
            : executable.knownUserBinDirSuffixes
                ? { knownUserBinDirSuffixes: Object.freeze([...executable.knownUserBinDirSuffixes]) }
                : {}),
        ...(executable.systemCommandResolutionStrategy
            ? { systemCommandResolutionStrategy: executable.systemCommandResolutionStrategy }
            : {}),
        sourcePreferenceDefault: executable.sourcePreference,
        managedInstall: install.managed ?? null,
        manualInstallKind: install.manual.kind,
        manualInstallRecipes,
        acceptsJavaScriptFileOverride: executable.acceptsJavaScriptFileOverride ?? false,
        ...(install.recommendationOrder !== undefined
            ? { setupRecommendation: Object.freeze({ order: install.recommendationOrder }) }
            : {}),
        ...(install.guideUrl !== undefined ? { installGuideUrl: install.guideUrl } : {}),
        ...(install.docsUrl !== undefined ? { docsUrl: install.docsUrl } : {}),
    });
}

function createMetadataAuthStatusProbe(
    probe: PluginAgentCliAuthProbeMetadata,
): CliAuthSpec['detectAuthStatus'] {
    if (probe.parser === 'none') return undefined;

    if (probe.parser === 'envOnly' || probe.parser === 'piEnvOnly') {
        return async () => {
            const status = resolveCommonApiKeyStatus(probe.envVars ?? []);
            return status.state === 'logged_in'
                ? status
                : { state: 'logged_out', reason: 'missing_credentials' };
        };
    }

    if (probe.parser === 'unknown') {
        return async () => {
            const status = resolveCommonApiKeyStatus(probe.envVars ?? []);
            return status.state === 'logged_in'
                ? status
                : { state: 'unknown', reason: 'unsupported' };
        };
    }

    return async ({ resolvedPath }) => {
        const environmentStatus = resolveMetadataEnvironmentStatus(probe);
        if (environmentStatus) return environmentStatus;

        if (probe.parser === 'claudeCredentialsFile') {
            return resolveClaudeCredentialMetadataStatus(probe);
        }

        if (probe.parser === 'geminiCredentialFiles') {
            return resolveTokenCredentialMetadataStatus(probe);
        }

        if (probe.parser === 'copilotGhAuth') {
            const result = await runCliCommandBestEffort({
                resolvedPath: 'gh',
                args: ['auth', 'token'],
                timeoutMs: 1_500,
            });
            return result.ok && `${result.stdout}\n${result.stderr}`.trim().length > 0
                ? { state: 'logged_in', method: 'oauth_cli', source: 'command' }
                : commandFailureStatus(result.exitCode);
        }

        const statusArgs = probe.statusArgs;
        if (!statusArgs) return { state: 'unknown', reason: 'unsupported' };
        const result = await runCliCommandBestEffort({
            resolvedPath,
            args: [...statusArgs],
            timeoutMs: 6_000,
        });

        if (probe.parser === 'codexLoginStatus') {
            if (result.ok) {
                return { state: 'logged_in', method: 'oauth_cli', source: 'command' };
            }
            if (result.exitCode === null) {
                const credentialStatus = resolveTokenCredentialMetadataStatus(probe);
                if (credentialStatus.state === 'logged_in') return credentialStatus;
            }
            return commandFailureStatus(result.exitCode);
        }

        if (probe.parser === 'opencodeAuthList') {
            const accountLabel = extractEmail(result.stdout);
            return result.ok && result.stdout.trim().length > 0
                ? {
                    state: 'logged_in',
                    method: 'oauth_cli',
                    source: 'command',
                    ...(accountLabel ? { accountLabel } : {}),
                }
                : commandFailureStatus(result.exitCode);
        }

        if (probe.parser === 'kiroWhoamiJson') {
            if (!result.ok) return commandFailureStatus(result.exitCode);
            const accountLabel = readAccountLabelFromJson(result.stdout);
            return {
                state: 'logged_in',
                method: 'oauth_cli',
                source: 'command',
                ...(accountLabel ? { accountLabel } : {}),
            };
        }

        if (probe.parser === 'cursorAboutJson') {
            if (!result.ok) return commandFailureStatus(result.exitCode);
            const parsed = parseRecord(result.stdout);
            if (!parsed) {
                return { state: 'unknown', reason: 'probe_failed', source: 'command' };
            }
            const user = readRecordField(parsed, 'user') ?? readRecordField(parsed, 'userInfo');
            const accountLabel = readAccountLabel(user) ?? readAccountLabel(parsed);
            return accountLabel
                ? { state: 'logged_in', method: 'oauth_cli', source: 'command', accountLabel }
                : { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
        }

        return { state: 'unknown', reason: 'unsupported' };
    };
}

function resolveMetadataEnvironmentStatus(
    probe: PluginAgentCliAuthProbeMetadata,
) {
    const envName = (probe.envVars ?? []).find((name) => {
        const value = process.env[name];
        return typeof value === 'string' && value.trim().length > 0;
    });
    if (!envName) return null;
    return {
        state: 'logged_in' as const,
        method: probe.parser === 'claudeCredentialsFile' && envName.includes('AUTH_TOKEN')
            ? 'auth_token_env' as const
            : 'api_key_env' as const,
        source: 'env' as const,
    };
}

function commandFailureStatus(exitCode: number | null) {
    return exitCode === null
        ? { state: 'unknown' as const, reason: 'probe_failed' as const, source: 'command' as const }
        : { state: 'logged_out' as const, reason: 'missing_credentials' as const, source: 'command' as const };
}

function parseRecord(raw: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function readRecordField(
    record: Record<string, unknown> | null,
    key: string,
): Record<string, unknown> | null {
    const value = record?.[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readAccountLabel(record: Record<string, unknown> | null): string | null {
    for (const key of ['email', 'emailAddress', 'username', 'displayName', 'name', 'id']) {
        const value = record?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

function readAccountLabelFromJson(raw: string): string | null {
    return readAccountLabel(parseRecord(raw));
}

function extractEmail(raw: string): string | null {
    return raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]?.trim() ?? null;
}

function readDeclaredCredentialRecords(
    probe: PluginAgentCliAuthProbeMetadata,
): readonly Record<string, unknown>[] {
    return (probe.credentialPaths ?? [])
        .map((path) => readJsonFileSafe(expandHomeDirPath(path, process.env, process.platform)))
        .filter((value): value is Record<string, unknown> => (
            value !== null && typeof value === 'object' && !Array.isArray(value)
        ));
}

function recordHasCredentialToken(record: Record<string, unknown>, depth = 0): boolean {
    if (depth > 3) return false;
    for (const [key, value] of Object.entries(record)) {
        if (
            typeof value === 'string'
            && value.trim().length > 0
            && /(?:token|api_?key|credential)/i.test(key)
        ) {
            return true;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (recordHasCredentialToken(value as Record<string, unknown>, depth + 1)) return true;
        }
    }
    return false;
}

function resolveTokenCredentialMetadataStatus(
    probe: PluginAgentCliAuthProbeMetadata,
) {
    const record = readDeclaredCredentialRecords(probe).find(recordHasCredentialToken);
    const accountLabel = record ? readAccountLabel(record) : null;
    return record
        ? {
            state: 'logged_in' as const,
            method: 'credentials_file' as const,
            source: 'file' as const,
            ...(accountLabel ? { accountLabel } : {}),
        }
        : { state: 'logged_out' as const, reason: 'missing_credentials' as const };
}

function resolveClaudeCredentialMetadataStatus(
    probe: PluginAgentCliAuthProbeMetadata,
) {
    let sawExpired = false;
    for (const record of readDeclaredCredentialRecords(probe)) {
        const credential = readRecordField(record, 'claudeAiOauth') ?? record;
        const token = ['accessToken', 'access_token']
            .map((key) => credential[key])
            .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
        if (!token) continue;
        const expiresAt = credential.expiresAt;
        const expiryMs = typeof expiresAt === 'number'
            ? expiresAt
            : typeof expiresAt === 'string'
                ? Date.parse(expiresAt)
                : Number.NaN;
        if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
            sawExpired = true;
            continue;
        }
        const oauthAccount = readRecordField(record, 'oauthAccount');
        const accountLabel = readAccountLabel(oauthAccount) ?? readAccountLabel(record);
        return {
            state: 'logged_in' as const,
            method: 'credentials_file' as const,
            source: 'file' as const,
            ...(accountLabel ? { accountLabel } : {}),
        };
    }
    return sawExpired
        ? {
            state: 'logged_out' as const,
            reason: 'expired' as const,
            method: 'credentials_file' as const,
            source: 'file' as const,
        }
        : { state: 'logged_out' as const, reason: 'missing_credentials' as const };
}

export function createNativeAgentCliAuthSpec(cli: PluginAgentCliMetadata): CliAuthSpec {
    const detectAuthStatus = createMetadataAuthStatusProbe(cli.auth.probe);
    return {
        binaryNames: [
            cli.executable.binaryName,
            ...(cli.executable.alternativeBinaryNames ?? []),
        ],
        ...(detectAuthStatus ? { detectAuthStatus } : {}),
    };
}

export function createNativeAgentCliCatalogEntry(params: Readonly<{
    agentId: string;
    cli: PluginAgentCliMetadata;
}>): ResolvedCatalogEntry {
    return Object.freeze({
        id: params.agentId,
        cliSubcommand: params.agentId,
        vendorResumeSupport: 'unsupported',
        getCliDetect: async () => ({
            versionArgsToTry: [['--version'], ['version'], ['-v']],
            loginStatusArgs: params.cli.auth.probe.statusArgs ?? null,
        }),
        getCliAuthSpec: async () => createNativeAgentCliAuthSpec(params.cli),
    });
}

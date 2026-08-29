import type {
    ConnectedAccountServiceKey,
    ConnectedServiceId,
    PluginAgentContributionV2,
    PluginAgentCliMetadata,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import {
    buildQualifiedPluginContributionKey,
    isPluginAgentCliAuthBackgroundCheckSafe,
} from '@happier-dev/protocol';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';

import type { CliAuthSpec, CliAuthStatusDraft } from '@/capabilities/cliAuth/types';
import { readJsonFileSafe } from '@/capabilities/cliAuth/shared';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { readAgentExecutionRunCapabilities, readAgentSessionCapabilities } from './agentContributionDefinition';
import { resolveFirstPartyLegacyAgentConnectedAccountServiceId } from './connectedAccountPurposeCompatibility';
import type { ResolvedCatalogEntry, ResolvedContributionProvenance } from './types';

/**
 * Read a declared manifest title, accepting both the plain-string and the
 * localized `{ key, fallback }` authoring shapes. Returns null when the
 * declaration carries no usable text, so callers decide their own fallback.
 */
export function readDeclaredAgentTitle(title: unknown): string | null {
    if (typeof title === 'string' && title.trim().length > 0) return title.trim();
    if (title && typeof title === 'object' && !Array.isArray(title)) {
        const localizedFallback = Reflect.get(title, 'fallback');
        if (typeof localizedFallback === 'string' && localizedFallback.trim().length > 0) {
            return localizedFallback.trim();
        }
    }
    return null;
}

export function readAgentDisplayTitle(title: unknown, fallback: string): string {
    return readDeclaredAgentTitle(title) ?? fallback;
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
        title: params.cli.displayName ?? readAgentDisplayTitle(params.title, params.agentId),
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

export type NativeAgentCliAuthStaticProbe = Readonly<{
    readPresentCredential(): CliAuthStatusDraft | null;
    missingCredentialStatus(): CliAuthStatusDraft;
}>;

function hasEnvironmentCredential(environmentVariables: readonly string[]): boolean {
    return environmentVariables.some((name) => {
        const value = process.env[name];
        return typeof value === 'string' && value.trim().length > 0;
    });
}

function recordHasCredentialToken(record: Record<string, unknown>, depth = 0): boolean {
    if (depth > 3) return false;
    for (const [key, value] of Object.entries(record)) {
        if (
            typeof value === 'string'
            && value.trim().length > 0
            && /(?:token|api_?key|credential)/iu.test(key)
        ) {
            return true;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (recordHasCredentialToken(value as Record<string, unknown>, depth + 1)) return true;
        }
    }
    return false;
}

function hasFileCredential(credentialPaths: readonly string[]): boolean {
    return credentialPaths.some((path) => {
        const record = readJsonFileSafe(expandHomeDirPath(path, process.env, process.platform));
        return record !== null && typeof record === 'object' && !Array.isArray(record)
            && recordHasCredentialToken(record as Record<string, unknown>);
    });
}

/**
 * The manifest owns only bounded credential-presence facts. This host owner
 * reads them once; Agent callbacks never receive raw environment or file data.
 */
export function createNativeAgentCliAuthStaticProbe(
    cli: PluginAgentCliMetadata,
): NativeAgentCliAuthStaticProbe | null {
    const environmentVariables = cli.auth.environmentVariables ?? [];
    const credentialPaths = cli.auth.credentialPaths ?? [];
    if (environmentVariables.length === 0 && credentialPaths.length === 0) return null;

    const missingCredentialStatus: CliAuthStatusDraft = cli.auth.missingCredentialState === 'unknown'
        ? { state: 'unknown', reason: 'unsupported' }
        : { state: 'logged_out', reason: 'missing_credentials' };
    return Object.freeze({
        readPresentCredential: (): CliAuthStatusDraft | null => {
            if (hasEnvironmentCredential(environmentVariables)) {
                return { state: 'logged_in', method: 'api_key_env', source: 'env' };
            }
            if (hasFileCredential(credentialPaths)) {
                return { state: 'logged_in', method: 'credentials_file', source: 'file' };
            }
            return null;
        },
        missingCredentialStatus: () => missingCredentialStatus,
    });
}

export function createNativeAgentCliAuthSpec(cli: PluginAgentCliMetadata): CliAuthSpec {
    const staticProbe = createNativeAgentCliAuthStaticProbe(cli);
    return {
        binaryNames: [
            cli.executable.binaryName,
            ...(cli.executable.alternativeBinaryNames ?? []),
        ],
        isSafeForBackgroundChecks: isPluginAgentCliAuthBackgroundCheckSafe(cli),
        ...(staticProbe
            ? {
                detectAuthStatus: async () => (
                    staticProbe.readPresentCredential() ?? staticProbe.missingCredentialStatus()
                ),
            }
            : {}),
    };
}

const NO_LEGACY_CONNECTED_SERVICE_IDS: readonly ConnectedServiceId[] = Object.freeze([]);

function resolveManifestAgentConnectedAccountServiceIds(params: Readonly<{
    definition: PluginAgentContributionV2;
    pluginId: string;
}>): readonly ConnectedAccountServiceKey[] {
    const ids = new Set<ConnectedAccountServiceKey>();
    for (const declaration of params.definition.connectedAccounts ?? []) {
        const service: QualifiedConnectedAccountRef['service'] =
            typeof declaration.service === 'string'
                ? { pluginId: params.pluginId, localId: declaration.service }
                : declaration.service;
        ids.add(buildQualifiedPluginContributionKey(service));
    }
    return Object.freeze([...ids]);
}

/**
 * Legacy service-keyed Connected Service ids are the host-private compatibility
 * input for the retained bundled first-party adapters: they route an Agent
 * onto the service-keyed credential owner and earn the request-auth
 * `legacyServiceKeyedCompatibility` certificate at spawn, foreground admission,
 * execution runs and reattach. An external manifest can name the same built-in
 * service ref, which proves nothing about provenance, so the projection is
 * first-party only and every external Agent stays on the qualified purpose
 * binding owner with its declared Connected Account capability intact.
 */
function resolveManifestAgentConnectedServiceIds(params: Readonly<{
    definition: PluginAgentContributionV2;
    pluginId: string;
    provenance: ResolvedContributionProvenance;
}>): readonly ConnectedServiceId[] {
    if (params.provenance !== 'first_party') return NO_LEGACY_CONNECTED_SERVICE_IDS;
    const ids = new Set<ConnectedServiceId>();
    for (const declaration of params.definition.connectedAccounts ?? []) {
        const service: QualifiedConnectedAccountRef['service'] =
            typeof declaration.service === 'string'
                ? { pluginId: params.pluginId, localId: declaration.service }
                : declaration.service;
        const serviceId = resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
        if (serviceId) ids.add(serviceId);
    }
    return Object.freeze([...ids]);
}

export function createManifestAgentCatalogEntry(params: Readonly<{
    agentId: string;
    pluginId: string;
    definition: PluginAgentContributionV2;
    cli: PluginAgentCliMetadata | null;
    provenance: ResolvedContributionProvenance;
}>): ResolvedCatalogEntry | null {
    const sessionCapabilities = readAgentSessionCapabilities(params.definition);
    const executionRunCapabilities = readAgentExecutionRunCapabilities(params.definition)
        ?? undefined;
    if (!sessionCapabilities && !executionRunCapabilities) return null;
    const cli = params.cli;
    const connectedServiceIds = resolveManifestAgentConnectedServiceIds(params);
    const connectedAccountServiceIds = resolveManifestAgentConnectedAccountServiceIds(params);
    const toolDelivery = 'tools' in params.definition.capabilities
        ? params.definition.capabilities.tools?.delivery
        : undefined;

    return Object.freeze({
        id: params.agentId,
        cliSubcommand: params.agentId,
        // Inferred default only. An Agent that declares `catalog.vendorResume`
        // overrides this through the catalog-entry hook family, which is the
        // only way to express `experimental`.
        vendorResumeSupport: sessionCapabilities?.open.includes('resume') === true
            ? 'supported'
            : 'unsupported',
        ...(toolDelivery
            ? { toolDelivery }
            : {}),
        ...(connectedServiceIds.length > 0 ? { connectedServiceIds } : {}),
        ...(connectedAccountServiceIds.length > 0 ? { connectedAccountServiceIds } : {}),
        ...(cli
            ? {
                getCliDetect: async () => ({
                    versionArgsToTry: [['--version'], ['version'], ['-v']],
                    loginStatusArgs: null,
                }),
                getCliAuthSpec: async () => createNativeAgentCliAuthSpec(cli),
            }
            : {}),
    });
}

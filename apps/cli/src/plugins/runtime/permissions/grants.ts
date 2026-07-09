import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';

import type {
    PluginPermissionGrantAuthoritySourceV1,
    PluginPermissionCapabilityV1,
    PluginPermissionDeclarationV1,
    PluginPermissionGrantListActionInputV1,
    PluginPermissionGrantV1,
    PluginSourceSpecV1,
} from '@happier-dev/protocol';
import { PluginPermissionGrantListActionOutputV1Schema as GrantListOutputSchema } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readCredentials, readSettings } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

type TrustedOptionalPluginContributionProvenance = 'first_party' | 'external';

export type TrustedOptionalPluginPermissionGrant = PluginPermissionGrantV1;

export type TrustedOptionalPluginPermissionGrantRequest = Readonly<{
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    optionalPermissions: readonly PluginPermissionDeclarationV1[];
    requiredPermissions: readonly PluginPermissionDeclarationV1[];
    provenance?: TrustedOptionalPluginContributionProvenance;
    sourceSpec?: PluginSourceSpecV1;
}>;

export type ResolveTrustedOptionalPluginPermissionGrants = (
    request: TrustedOptionalPluginPermissionGrantRequest,
) => Promise<readonly TrustedOptionalPluginPermissionGrant[]> | readonly TrustedOptionalPluginPermissionGrant[];

function permissionDeclarationKey(permission: PluginPermissionDeclarationV1): string {
    return `${permission.capability}\u0000${permission.scope?.trim() ?? ''}`;
}

function isGlobalRuntimeGrant(grant: TrustedOptionalPluginPermissionGrant): boolean {
    return grant.targetScope.kind === 'account';
}

function authoritySourcesMatch(
    left: PluginPermissionGrantAuthoritySourceV1,
    right: PluginPermissionGrantAuthoritySourceV1,
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'bundled') return true;
    return right.kind === 'machine_installation'
        && left.machineId === right.machineId
        && left.installationId === right.installationId;
}

async function resolveNullableBestEffort<T>(
    load: () => T | null | undefined | Promise<T | null | undefined>,
): Promise<T | null> {
    try {
        return await load() ?? null;
    } catch {
        return null;
    }
}

async function resolveLocalMachineInstallationGrantAuthoritySource(): Promise<PluginPermissionGrantAuthoritySourceV1 | null> {
    const settings = await resolveNullableBestEffort(() => readSettings());
    const machineId = typeof settings?.machineId === 'string' ? settings.machineId.trim() : '';
    if (!machineId) {
        return null;
    }
    const identity = (() => {
        try {
            return readInstallationIdentityIfExistsSync();
        } catch {
            return null;
        }
    })();
    if (!identity?.installationId) {
        return null;
    }
    return {
        kind: 'machine_installation',
        machineId,
        installationId: identity.installationId,
    };
}

function isTrustedGrantAuthorityForRuntime(params: Readonly<{
    grant: TrustedOptionalPluginPermissionGrant;
    provenance?: TrustedOptionalPluginContributionProvenance;
    localAuthoritySource: PluginPermissionGrantAuthoritySourceV1 | null;
}>): boolean {
    if (params.grant.authoritySource.kind === 'bundled') {
        return params.provenance === 'first_party';
    }
    return params.localAuthoritySource !== null
        && authoritySourcesMatch(params.grant.authoritySource, params.localAuthoritySource);
}

export function resolveTrustedOptionalPermissionDeclarations(params: Readonly<{
    pluginId: string;
    optionalPermissions: readonly PluginPermissionDeclarationV1[];
    grants: readonly TrustedOptionalPluginPermissionGrant[];
    provenance?: TrustedOptionalPluginContributionProvenance;
    localAuthoritySource?: PluginPermissionGrantAuthoritySourceV1 | null;
}>): readonly PluginPermissionDeclarationV1[] {
    if (params.optionalPermissions.length === 0 || params.grants.length === 0) {
        return Object.freeze([]);
    }

    const optionalDeclarationsByCapability = new Map<PluginPermissionCapabilityV1, PluginPermissionDeclarationV1[]>();
    for (const declaration of params.optionalPermissions) {
        const declarations = optionalDeclarationsByCapability.get(declaration.capability) ?? [];
        declarations.push(declaration);
        optionalDeclarationsByCapability.set(declaration.capability, declarations);
    }

    const trusted = new Map<string, PluginPermissionDeclarationV1>();
    for (const grant of params.grants) {
        if (grant.pluginId !== params.pluginId || grant.status !== 'active' || !isGlobalRuntimeGrant(grant)) {
            continue;
        }
        if (!isTrustedGrantAuthorityForRuntime({
            grant,
            provenance: params.provenance,
            localAuthoritySource: params.localAuthoritySource ?? null,
        })) {
            continue;
        }
        const declarations = optionalDeclarationsByCapability.get(grant.capability) ?? [];
        if (declarations.length === 0) {
            continue;
        }
        for (const declaration of declarations) {
            trusted.set(permissionDeclarationKey(declaration), declaration);
        }
    }

    return Object.freeze([...trusted.values()]);
}

export async function loadTrustedOptionalPermissionDeclarations(params: Readonly<{
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    requiredPermissions: readonly PluginPermissionDeclarationV1[];
    optionalPermissions: readonly PluginPermissionDeclarationV1[];
    provenance?: TrustedOptionalPluginContributionProvenance;
    sourceSpec?: PluginSourceSpecV1;
    resolveTrustedOptionalPermissionGrants?: ResolveTrustedOptionalPluginPermissionGrants;
}>): Promise<readonly PluginPermissionDeclarationV1[]> {
    if (!params.resolveTrustedOptionalPermissionGrants || params.optionalPermissions.length === 0) {
        return Object.freeze([]);
    }

    const grants = await params.resolveTrustedOptionalPermissionGrants({
        pluginId: params.pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: params.manifestDigest,
        requiredPermissions: params.requiredPermissions,
        optionalPermissions: params.optionalPermissions,
        ...(params.provenance ? { provenance: params.provenance } : {}),
        ...(params.sourceSpec ? { sourceSpec: params.sourceSpec } : {}),
    });
    const localAuthoritySource = await resolveLocalMachineInstallationGrantAuthoritySource();

    return resolveTrustedOptionalPermissionDeclarations({
        pluginId: params.pluginId,
        optionalPermissions: params.optionalPermissions,
        grants,
        provenance: params.provenance,
        localAuthoritySource,
    });
}

export async function resolveTrustedOptionalPermissionGrantsFromServer(
    request: TrustedOptionalPluginPermissionGrantRequest,
): Promise<readonly TrustedOptionalPluginPermissionGrant[]> {
    if (request.optionalPermissions.length === 0) {
        return Object.freeze([]);
    }

    const credentials = await resolveNullableBestEffort(() => readCredentials());
    if (!credentials) {
        return Object.freeze([]);
    }

    const body: PluginPermissionGrantListActionInputV1 = {
        pluginId: request.pluginId,
        targetScope: { kind: 'account' },
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 200,
    };
    const config: AxiosRequestConfig = {
        headers: {
            Authorization: `Bearer ${credentials.token}`,
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
    };
    const response = await resolveNullableBestEffort<AxiosResponse<unknown>>(() => axios.post(
        `${resolveServerHttpBaseUrl()}/v1/plugins/permissions/grants/list`,
        body,
        config,
    ));
    if (!response || response.status < 200 || response.status >= 300) {
        return Object.freeze([]);
    }

    const parsed = GrantListOutputSchema.safeParse(response.data);
    if (!parsed.success) {
        return Object.freeze([]);
    }

    const optionalCapabilities = new Set(request.optionalPermissions.map((permission) => permission.capability));
    const localAuthoritySource = await resolveLocalMachineInstallationGrantAuthoritySource();
    return Object.freeze(parsed.data.grants.filter((grant) => (
        grant.pluginId === request.pluginId
        && grant.status === 'active'
        && isGlobalRuntimeGrant(grant)
        && isTrustedGrantAuthorityForRuntime({
            grant,
            provenance: request.provenance,
            localAuthoritySource,
        })
        && optionalCapabilities.has(grant.capability)
    )));
}

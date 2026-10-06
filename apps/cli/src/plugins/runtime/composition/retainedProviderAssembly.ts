import { isDeepStrictEqual } from 'node:util';

import { ProviderRuntimeBindingBasisV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import type { PluginContributionIdentityV1, ProviderRuntimeBindingBasisV1 } from '@happier-dev/protocol';

import type { PluginStorePaths } from '../../store/paths';
import type { PluginSourceCustody } from '../sourceAuthority';
import { attestRetainedPluginSource } from '../retainedPluginSourceAttestation';

export type RetainedManagedProviderAttestation = Readonly<{
    identity: PluginContributionIdentityV1;
    sessionId: string;
    occurrenceId: string;
    sourceCustody: Exclude<PluginSourceCustody, Readonly<{ kind: 'development' }>>;
    manifestAuthority: 'external' | 'bundled_first_party';
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1 & Readonly<{
        deployment: Extract<
            ProviderRuntimeBindingBasisV1['deployment'],
            Readonly<{ kind: 'managedLocal' }>
        >;
    }>;
    declaration: ReturnType<typeof resolveProviderManagedRuntimeDeclarationV1>;
    pluginVersion: string;
    requiredHostAccess: Awaited<ReturnType<typeof attestRetainedPluginSource>>['manifest']['hostAccess']['required'];
    assertStillAvailable(): Promise<void>;
}>;

export async function attestRetainedManagedProvider(input: Readonly<{
    paths: PluginStorePaths;
    sessionId: string;
    identity: PluginContributionIdentityV1;
    occurrenceId: string;
    sourceCustody: PluginSourceCustody;
    manifestAuthority: 'external' | 'bundled_first_party';
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
}>): Promise<RetainedManagedProviderAttestation | null> {
    const identity = createPluginContributionIdentity(input.identity);
    const sessionId = input.sessionId.trim();
    const occurrenceId = input.occurrenceId.trim();
    const runtimeBindingBasis = ProviderRuntimeBindingBasisV1Schema.parse(input.runtimeBindingBasis);
    if (
        !sessionId
        || !occurrenceId
        || input.sourceCustody.kind === 'development'
        || (input.sourceCustody.kind === 'managed'
            ? input.manifestAuthority !== 'external'
            : input.manifestAuthority !== 'bundled_first_party')
        || runtimeBindingBasis.deployment.kind !== 'managedLocal'
        || !isDeepStrictEqual(
            runtimeBindingBasis.deployment.implementationIdentity,
            identity,
        )
    ) return null;
    const managedRuntimeBindingBasis = runtimeBindingBasis as
        RetainedManagedProviderAttestation['runtimeBindingBasis'];
    let retainedSource: Awaited<ReturnType<typeof attestRetainedPluginSource>>;
    try {
        retainedSource = await attestRetainedPluginSource({
            paths: input.paths,
            pluginId: identity.pluginId,
            custody: input.sourceCustody,
        });
    } catch {
        return null;
    }
    if (retainedSource.manifestAuthority !== input.manifestAuthority) return null;
    const provider = retainedSource.manifest.contributes.providers.find(
        (candidate) => candidate.id === identity.localId,
    );
    if (provider?.managedRuntime?.kind !== 'managed') return null;
    const declaration = resolveProviderManagedRuntimeDeclarationV1({
        implementationIdentity: identity,
        managedRuntime: provider.managedRuntime,
    });
    const endpoint = provider.endpointTemplates.find(
        (candidate) => candidate.id === runtimeBindingBasis.endpoint.endpointTemplateId,
    );
    if (
        !declaration.endpointTemplateIds.includes(runtimeBindingBasis.endpoint.endpointTemplateId)
        || endpoint?.protocol !== runtimeBindingBasis.endpoint.protocol
        || !isDeepStrictEqual(declaration, runtimeBindingBasis.deployment.managedRuntime)
    ) return null;
    try {
        await retainedSource.assertStillAvailable();
    } catch {
        return null;
    }
    return Object.freeze({
        identity,
        sessionId,
        occurrenceId,
        sourceCustody: input.sourceCustody,
        manifestAuthority: input.manifestAuthority,
        runtimeBindingBasis: managedRuntimeBindingBasis,
        declaration,
        pluginVersion: retainedSource.manifest.version,
        requiredHostAccess: retainedSource.manifest.hostAccess.required,
        assertStillAvailable: retainedSource.assertStillAvailable,
    });
}

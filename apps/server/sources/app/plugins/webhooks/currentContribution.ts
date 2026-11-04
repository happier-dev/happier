import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';

import {
    currentPluginDeclarationKeyV1,
    resolveCurrentPluginDeclarationsTx,
    resolveCurrentPluginDeclarationTx,
} from '@/app/plugins/availability/currentDeclaration';
import type { Tx } from '@/storage/inTx';

import type {
    ResolvedPluginWebhookContributionV1,
    ResolvedPluginWebhookTargetV1,
} from './endpointStore';

export type CurrentPluginWebhookClaimAuthorityV1 = Readonly<{
    materializationId: string;
    pluginId: string;
    version: string;
    contribution: ResolvedPluginWebhookContributionV1;
}>;

function projectPluginWebhookContributionsV1(
    manifest: ParsedPluginManifestV2,
): readonly ResolvedPluginWebhookContributionV1[] {
    return manifest.contributes.webhooks.flatMap((contribution): ResolvedPluginWebhookContributionV1[] => {
        // Executable claims require an Action; receipt-only endpoints have no dispatch work.
        if (!('handlerAction' in contribution)) return [];
        return [Object.freeze({
            pluginId: manifest.id,
            localId: contribution.id,
            handlerActionLocalId: contribution.handlerAction.localId,
            verifierKind: contribution.verifier.kind,
            routingKind: contribution.verifier.routing,
        })];
    });
}

/**
 * Resolves every current webhook contribution for Availability-classified
 * targets in fixed database work. Claim selection uses this projection to skip
 * any number of rows whose frozen contribution is no longer executable.
 */
export async function resolveCurrentPluginWebhookClaimAuthoritiesTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    targets: readonly Readonly<{
        materializationId: string;
        pluginId: string;
        version: string;
    }>[];
}>): Promise<readonly CurrentPluginWebhookClaimAuthorityV1[]> {
    if (params.targets.length === 0) return [];
    const declarations = await resolveCurrentPluginDeclarationsTx({
        tx: params.tx,
        accountId: params.accountId,
        refs: params.targets,
    });
    return params.targets.flatMap((target) => {
        const declaration = declarations.get(currentPluginDeclarationKeyV1(target.pluginId, target.version));
        if (!declaration) return [];
        return projectPluginWebhookContributionsV1(declaration.manifest).map((contribution) => Object.freeze({
            materializationId: target.materializationId,
            pluginId: target.pluginId,
            version: target.version,
            contribution,
        }));
    });
}

/** Canonical current-manifest resolver shared by endpoint correspondence and claimed dispatch. */
export async function resolveCurrentPluginWebhookContributionTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    contribution: Readonly<{ pluginId: string; localId: string }>;
    target: ResolvedPluginWebhookTargetV1;
}>): Promise<ResolvedPluginWebhookContributionV1 | null> {
    if (params.contribution.pluginId !== params.target.materialization.pluginId) return null;
    const declaration = await resolveCurrentPluginDeclarationTx({
        tx: params.tx,
        accountId: params.accountId,
        pluginId: params.contribution.pluginId,
        version: params.target.pluginVersion,
    });
    if (!declaration) return null;
    return projectPluginWebhookContributionsV1(declaration.manifest).find(
        (candidate) => candidate.localId === params.contribution.localId,
    ) ?? null;
}

import { PluginManifestV2Schema } from '@happier-dev/protocol';

import type { Tx } from '@/storage/inTx';

import type {
    ResolvedPluginWebhookContributionV1,
    ResolvedPluginWebhookTargetV1,
} from './endpointStore';

/** Canonical current-manifest resolver shared by endpoint correspondence and claimed dispatch. */
export async function resolveCurrentPluginWebhookContributionTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    contribution: Readonly<{ pluginId: string; localId: string }>;
    target: ResolvedPluginWebhookTargetV1;
}>): Promise<ResolvedPluginWebhookContributionV1 | null> {
    if (params.contribution.pluginId !== params.target.materialization.pluginId) return null;
    const [intent, release] = await Promise.all([
        params.tx.accountPluginIntent.findUnique({
            where: {
                accountId_pluginId: {
                    accountId: params.accountId,
                    pluginId: params.contribution.pluginId,
                },
            },
            select: { enabled: true, desiredVersion: true },
        }),
        params.tx.accountPluginRelease.findUnique({
            where: {
                accountId_pluginId_version: {
                    accountId: params.accountId,
                    pluginId: params.contribution.pluginId,
                    version: params.target.pluginVersion,
                },
            },
            select: { normalizedManifest: true },
        }),
    ]);
    if (!intent?.enabled || intent.desiredVersion !== params.target.pluginVersion || !release) return null;
    const manifest = PluginManifestV2Schema.safeParse(release.normalizedManifest);
    if (!manifest.success || manifest.data.id !== params.contribution.pluginId) return null;
    const contribution = manifest.data.contributes.webhooks.find(
        (candidate) => candidate.id === params.contribution.localId,
    );
    if (!contribution) return null;
    return {
        pluginId: manifest.data.id,
        localId: contribution.id,
        handlerActionLocalId: contribution.handlerAction.localId,
        verifierKind: contribution.verifier.kind,
        routingKind: contribution.verifier.routing,
    };
}

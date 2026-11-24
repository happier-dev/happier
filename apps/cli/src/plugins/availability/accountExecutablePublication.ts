import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1, PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactPublishActionInputV1Schema, PluginAvailabilityUiArtifactPublishActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { createPluginUiArtifactArchiveV1, encodePluginUiArtifactArchiveBodyV1 } from '@happier-dev/protocol/plugins/ui/artifactArchive';

import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAxiosResponseErrorCode } from '@/api/client/readAxiosResponseErrorCode';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { resolveContainedPluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import type { PluginAccountExecutableSource } from '@/plugins/store/registry/currentState';
import { logger } from '@/ui/logger';

import { postAvailability, readNamedAccountPluginIntentReads, type AccountReadBinding } from './accountReads';

/** Supplies bytes for an already approved Account selection through the Home's hosted Artifact owner. */
export async function publishInstalledAccountExecutables(
    binding: AccountReadBinding,
    sources: readonly PluginAccountExecutableSource[],
): Promise<void> {
    if (sources.length === 0) return;
    const reads = await readNamedAccountPluginIntentReads({ ...binding, pluginIds: sources.map(source => source.release.ref.pluginId) });
    const prepareEnvelope = createCredentialedAccountArtifactStore(binding.credentials).prepareStoredEnvelope;
    for (const source of sources) {
        const { ref, archiveDigestSha256 } = source.release;
        const read = reads.get(ref.pluginId);
        if (!read?.hostingCapability.enabled || !read.intent?.enabled || read.intent.offlineUiHosting !== 'enabled'
            || read.release?.ref.version !== ref.version || read.release.archiveDigestSha256 !== archiveDigestSha256) continue;

        for (const { graph, slots } of source.artifacts) {
            const missing = slots.filter(slot => !read.uiArtifacts.some(link => link.release.version === ref.version
                && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(slot, link)));
            if (missing.length === 0) continue;
            try {
                binding.signal?.throwIfAborted();
                const files = await Promise.all(graph.files.map(async file => {
                    const resource = await resolveContainedPluginResourcePath({
                        pluginRootPath: source.installedRoot,
                        resourcePath: `${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/${file.relativePath}`,
                    });
                    if (!resource) throw new Error('Installed Account executable file unavailable');
                    return { relativePath: file.relativePath, bytes: await readFile(resource.absolutePath, { signal: binding.signal }) };
                }));
                const archive = createPluginUiArtifactArchiveV1({ pluginId: ref.pluginId, artifactGraph: graph, files });
                if (!archive) throw new Error('Installed Account executable failed digest verification');
                const archiveBody = encodePluginUiArtifactArchiveBodyV1(archive.body);
                await runWithServerHttpBaseUrl(binding.serverUrl, async () => {
                    for (const slot of missing) {
                        // Each classified link owns a separate generic Artifact and content key.
                        const artifact = await prepareEnvelope({ header: archive.header, body: archiveBody, signal: binding.signal });
                        try {
                            const body = PluginAvailabilityUiArtifactPublishActionInputV1Schema.parse({
                                release: ref, slot, accountArtifactId: randomUUID(), artifact,
                            });
                            PluginAvailabilityUiArtifactPublishActionOutputV1Schema.parse(await postAvailability(binding,
                                PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.publish'], body));
                        } catch (error) {
                            binding.signal?.throwIfAborted();
                            logger.debug('[PLUGIN AVAILABILITY] Account executable publication refused', {
                                pluginId: ref.pluginId, artifactId: graph.artifactId, platform: slot.platform,
                                code: readAxiosResponseErrorCode(error),
                            });
                        }
                    }
                });
            } catch (error) {
                binding.signal?.throwIfAborted();
                // Artifact preparation failures must not suppress other approved releases.
                logger.debug('[PLUGIN AVAILABILITY] Account executable could not be prepared', {
                    pluginId: ref.pluginId, artifactId: graph.artifactId, code: readAxiosResponseErrorCode(error),
                });
            }
        }
    }
}

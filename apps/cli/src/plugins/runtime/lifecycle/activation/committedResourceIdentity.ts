import { realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { ResolvedContributionRegistry } from '../../../projection/registry/types';
import { assertContainedRegularGenerationFile, readCurrentCommittedPluginGenerations } from '../../../store/registry/generationStore';

export async function resolveCommittedRelativePath(rootPath: string, candidatePath: string): Promise<string | null> {
    const resolvedRoot = await realpath(resolve(rootPath));
    const resolvedCandidate = await realpath(resolve(candidatePath));
    const relativePath = relative(resolvedRoot, resolvedCandidate);
    if (
        resolvedCandidate === resolvedRoot
        || !isCanonicalAbsolutePathInsideRoot(resolvedRoot, resolvedCandidate)
    ) {
        return null;
    }
    return relativePath.split(sep).join('/');
}

export async function assertCommittedResourceActivationIdentity(params: Readonly<{
    candidate: ResolvedContributionRegistry;
    canonical: ResolvedContributionRegistry;
    committed: NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>>;
}>): Promise<void> {
    // A caller may supply a deliberately scoped registry (for example one Agent engine).
    // Validate every resource-bearing plugin admitted by that scope, but do not make unrelated
    // committed plugins a prerequisite for constructing the scoped runtime.
    const resourcePluginIds = new Set([
        ...params.candidate.resources.flatMap((resource) => (
            resource.pluginId && params.committed.generations.has(resource.pluginId) ? [resource.pluginId] : []
        )),
        ...(params.candidate.promptAssets ?? []).flatMap((asset) => (
            params.committed.generations.has(asset.pluginId) ? [asset.pluginId] : []
        )),
    ]);
    for (const pluginId of resourcePluginIds) {
        const committedGeneration = params.committed.generations.get(pluginId)!;
        if (!committedGeneration.record) {
            throw new Error(
                `Committed resource activation generation record is unavailable for '${pluginId}'`,
            );
        }
        const admittedPaths = new Set(committedGeneration.record.files.map((file) => file.relativePath));
        const canonicalTargets = params.canonical.activationTargets.filter((target) => target.pluginId === pluginId);
        const candidateTargets = params.candidate.activationTargets.filter((target) => target.pluginId === pluginId);
        const isBundledArtifact = canonicalTargets.some((target) => target.source.kind === 'bundled');

        for (const target of canonicalTargets) {
            if (target.source.kind === 'bundled') {
                if (target.daemonEntryPath && target.sourceSpec?.locator !== target.daemonEntryPath) {
                    throw new Error(`Bundled resource activation package identity mismatch for '${pluginId}'`);
                }
                continue;
            }
            const manifestRelativePath = await resolveCommittedRelativePath(
                committedGeneration.rootPath,
                target.manifestPath,
            );
            if (manifestRelativePath !== committedGeneration.record.manifestRelativePath) {
                throw new Error(
                    `Committed resource activation identity manifest path mismatch for '${pluginId}': ${manifestRelativePath ?? '<outside-generation>'}`,
                );
            }
            if (!admittedPaths.has(manifestRelativePath)) {
                throw new Error(`Committed resource activation identity manifest inventory mismatch for '${pluginId}'`);
            }
            await assertContainedRegularGenerationFile(
                committedGeneration.rootPath,
                manifestRelativePath,
                `Committed resource manifest for '${pluginId}'`,
            );
            for (const entryPath of [target.daemonEntryPath, target.devDaemonEntryPath]) {
                if (!entryPath) continue;
                const entryRelativePath = await resolveCommittedRelativePath(committedGeneration.rootPath, entryPath);
                if (!entryRelativePath || !admittedPaths.has(entryRelativePath)) {
                    throw new Error(`Committed resource activation identity runtime entry inventory mismatch for '${pluginId}'`);
                }
                await assertContainedRegularGenerationFile(
                    committedGeneration.rootPath,
                    entryRelativePath,
                    `Committed resource runtime entry for '${pluginId}'`,
                );
            }
        }

        const identity = async (target: (typeof canonicalTargets)[number]): Promise<string> => JSON.stringify({
            provenance: target.provenance,
            source: target.source,
            manifestPath: isBundledArtifact ? target.manifestPath : await realpath(resolve(target.manifestPath)),
            daemonEntryPath: isBundledArtifact
                ? target.daemonEntryPath
                : (target.daemonEntryPath ? await realpath(resolve(target.daemonEntryPath)) : null),
            devDaemonEntryPath: isBundledArtifact
                ? target.devDaemonEntryPath
                : (target.devDaemonEntryPath ? await realpath(resolve(target.devDaemonEntryPath)) : null),
            sourceSpec: target.sourceSpec,
            activationEvents: target.activationEvents ?? [],
            manifest: target.manifest,
        });
        const canonicalIdentities = (await Promise.all(canonicalTargets.map(identity))).sort();
        const candidateIdentities = (await Promise.all(candidateTargets.map(identity))).sort();
        if (JSON.stringify(candidateIdentities) !== JSON.stringify(canonicalIdentities)) {
            throw new Error(`Committed resource activation identity candidate mismatch for '${pluginId}'`);
        }
    }
}

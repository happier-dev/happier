import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
    BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH,
    classifyBundledPluginPublicationFailures,
    parseBundledPluginPublicationFailures,
    readBundledPluginUiArtifactsDigest,
} from '@happier-dev/cli-common/bundledPluginPublicationPolicy';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { isExecutingFirstPartySourceRuntime } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { logger } from '@/ui/logger';
import type { BundledPluginPublicationFailure } from '@/plugins/validation/diagnostics/types';

const requireFromCli = createRequire(import.meta.url);

/** The package root this runtime loads a bundled plugin from, or null when it is not installed. */
export function resolveInstalledBundledPluginRootPath(packageName: string): string | null {
    // Source runtime emission puts the plugin beside its CLI. Its immutable
    // graph and bytes must not come from the moving dependency symlink instead.
    if (isExecutingFirstPartySourceRuntime(import.meta.url) && packageName.startsWith('@happier-dev/plugins-')) {
        return resolveCliRuntimeAssetPath('../../packages/plugins', packageName.slice('@happier-dev/plugins-'.length));
    }
    for (const searchPath of requireFromCli.resolve.paths(packageName) ?? []) {
        const packageRootPath = join(searchPath, ...packageName.split('/'));
        if (existsSync(join(packageRootPath, 'package.json'))) {
            return packageRootPath;
        }
    }
    return null;
}

let admittedPublication: Readonly<{
    bytes: string;
    failures: readonly BundledPluginPublicationFailure[];
}> | null = null;

/** Runner staging consumes the publication admitted by this process, not later live writes. */
export function readAdmittedBundledPluginPublicationFailures(): string | null {
    return admittedPublication?.bytes ?? null;
}

/** Failures that withdraw a bundled package from this runtime (see the policy owner's classification). */
export function readCurrentBundledPluginPublicationFailures(): readonly BundledPluginPublicationFailure[] {
    if (admittedPublication) return admittedPublication.failures;
    let raw: string;
    try {
        raw = readFileSync(resolveCliRuntimeAssetPath(
            BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH,
        ), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('Bundled plugin publication state is unknown: the publication failure file is missing', { cause: error });
        }
        throw error;
    }
    const { withdrawn, superseded, retained } = classifyBundledPluginPublicationFailures(
        parseBundledPluginPublicationFailures(raw),
        (packageName) => {
            const pluginRootPath = resolveInstalledBundledPluginRootPath(packageName);
            return pluginRootPath === null ? undefined : readBundledPluginUiArtifactsDigest(pluginRootPath);
        },
    );
    if (superseded.length > 0 || retained.length > 0) {
        logger.warn('[plugins] bundled plugin publication failures not applied to this runtime', {
            superseded: superseded.map(({ packageName, diagnostic }) => `${packageName} ${diagnostic.code}`),
            retained: retained.map(({ packageName, diagnostic }) => `${packageName} ${diagnostic.code}: ${diagnostic.message}`),
        });
    }
    const failures = Object.freeze(withdrawn.map((failure) => Object.freeze({
        ...failure, diagnostic: Object.freeze({ ...failure.diagnostic }),
    })));
    // Runner snapshots inherit exactly what this process applied.
    admittedPublication = Object.freeze({ bytes: `${JSON.stringify(withdrawn)}\n`, failures });
    return admittedPublication.failures;
}

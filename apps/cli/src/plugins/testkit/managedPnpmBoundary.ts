import type { RunManagedPluginPnpmBoundary } from '@/plugins/daemon/developmentCandidateMaterializer';

/**
 * Canonical test stand-in for the managed-pnpm subprocess boundary used by the
 * plugin development-candidate materializer. Spawning the real package manager
 * from a unit test makes the case depend on a network registry and on the
 * fixture carrying a `package.json`, so every development-path test shares this
 * single successful-install boundary instead of restating the result shape.
 *
 * The parameter is optional so a case can either hand this straight to
 * `runManagedPluginPnpm` or call it from its own boundary double to supply the
 * success result after asserting the request.
 */
export const successfulManagedPluginPnpmBoundary = (async (
    _params?: Parameters<RunManagedPluginPnpmBoundary>[0],
) => ({
    ok: true as const,
    result: { exitCode: 0, signal: null, stdout: '', stderr: '' },
})) satisfies RunManagedPluginPnpmBoundary;

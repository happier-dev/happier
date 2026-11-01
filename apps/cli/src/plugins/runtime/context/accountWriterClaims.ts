import type { PluginError } from '@happier-dev/plugin-sdk';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

/** Host-private admission results, retained by the daemon across registry replacement. */
export type AccountPluginWriterClaim = Readonly<{
    manifest: CanonicalPluginManifest;
    occurrenceId: string | undefined;
    accountLifetimeToken: number;
    availabilityChangeKey: string;
    preparesCollections: boolean;
    diagnosticClaimAttemptId?: string;
    result: Promise<PluginError | null>;
}>;

export type AccountPluginWriterClaims = Map<string, AccountPluginWriterClaim>;

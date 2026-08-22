import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

const TRIAGE_DETAIL_MOUNT_KEY_DOMAIN_V1 = 'happier:triage:detail-mount-key:v1';

/**
 * The mount identity of one source detail body.
 *
 * The host folds this key into the contributed surface's mount identity
 * (`protocol/src/plugins/ui/targetedContributions.ts:160`) and RESETS the mount
 * lifecycle when it changes, so it must change on entry and on connection and on
 * nothing else: a refresh that re-reads the same selection must not throw away
 * the tab, scroll and parser state the source body is holding.
 *
 * `entryId` alone is not the entry. GitLab issue #5 and merge request !5 in one
 * project differ only by `kindId`, and two sources can answer for the same number
 * in different scopes, so a key naming only the number folds distinct entries
 * into one mount identity.
 *
 * **The key is DIGESTED because the host bounds it.**
 * `PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1` is 256
 * (`protocol/src/plugins/ui/semanticCommands.ts:77`) and over it the surface does
 * not throw — `TargetedPluginSurfaceHost` returns null and the reader gets a
 * generic "detail view unavailable" card that reads as a Happier fault. Joining
 * the reference in the clear cannot hold that bound: `collisionScope` alone is up
 * to 192 bytes and the identifiers 128 each, which reaches 549 bytes for a
 * contract-legal reference. An ordinary self-hosted Azure DevOps Server
 * collection base is long enough to cross it in practice, where a `dev.azure.com`
 * one never is (`scm-azure-devops/src/triage/identity.ts`).
 *
 * So this deliberately does NOT reuse `triageEntryRowKey`
 * (`projection/listWindow.ts:242`): that encoder is injective but UNBOUNDED by
 * design, for in-memory grouping and presentation where no ceiling applies. This
 * is the same split the composer attachment key already makes for the same reason
 * (`composer/attachmentValue.ts`), with its own domain separator so the two key
 * spaces cannot collide. The digest is injective over every component and always
 * 43 characters.
 */
export function deriveTriageDetailMountInstanceKey(
  entryRef: TriageEntryRefV1,
  sourceInstanceId: string,
): string {
  return computeCanonicalDomainSeparatedDigest(TRIAGE_DETAIL_MOUNT_KEY_DOMAIN_V1, [
    entryRef.source.pluginId,
    entryRef.source.localId,
    entryRef.kindId,
    entryRef.collisionScope,
    entryRef.entryId,
    sourceInstanceId,
  ]);
}

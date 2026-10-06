import { createHash } from 'node:crypto';

import { PluginInstallReviewPrincipalDigestSchema, PluginInstallReviewPrincipalPresentationV1Schema } from '@happier-dev/protocol/plugins/permissions/grants';
import type { PluginInstallReviewPrincipalDigest, PluginInstallReviewPrincipalPresentationV1 } from '@happier-dev/protocol';

import type { PluginInstallationReview } from '@happier-dev/protocol/marketplace/internal';

function distributionIdentity(
  review: PluginInstallationReview,
): PluginInstallReviewPrincipalPresentationV1['distributionIdentity'] {
  const channel = review.updateChannel;
  if (channel.kind === 'path') {
    return {
      kind: channel.kind,
      development: channel.development,
    };
  }
  if (channel.kind === 'archive') {
    return { kind: channel.kind };
  }
  return {
    kind: channel.kind,
    packageName: channel.packageName,
    registryOrigin: channel.registryOrigin,
    ...(channel.registryProfileId
      ? { registryProfileId: channel.registryProfileId }
      : {}),
  };
}

export function derivePluginInstallReviewPrincipalDigest(
  presentationInput: PluginInstallReviewPrincipalPresentationV1,
): PluginInstallReviewPrincipalDigest {
  const presentation = PluginInstallReviewPrincipalPresentationV1Schema.parse(presentationInput);
  return PluginInstallReviewPrincipalDigestSchema.parse(
    createHash('sha256')
      .update('happier.pluginInstallReviewPrincipal.v1\0', 'utf8')
      .update(JSON.stringify(presentation), 'utf8')
      .digest('hex'),
  );
}

export function pluginInstallReviewPrincipalPresentationMatchesDigest(
  digest: PluginInstallReviewPrincipalDigest,
  presentation: PluginInstallReviewPrincipalPresentationV1,
): boolean {
  return derivePluginInstallReviewPrincipalDigest(presentation) === digest;
}

/**
 * Derives the stable principal reviewed for a plugin installation.
 *
 * The presentation is exactly the authorization identity: plugin/package identity plus
 * the trusted distribution identity owned by the current installation channel.
 * Package version, artifact integrity, runtime bytes, unverified catalog publisher
 * labels, and npm registry signature keys are deliberately excluded: a registry
 * signing key authenticates the registry response rather than the publisher, and
 * catalog publisher labels are unverified presentation/curation metadata, so key
 * rotation and label changes are not publisher-channel changes (PEP-SDK r0.77 /
 * PEP-MASTER r0.138). Those facts stay visible on the installation review record
 * without participating in principal identity.
 */
export type PluginInstallReviewPrincipal = Readonly<{
  digest: PluginInstallReviewPrincipalDigest;
  presentation: PluginInstallReviewPrincipalPresentationV1;
}>;

export function derivePluginInstallReviewPrincipal(
  review: PluginInstallationReview,
): PluginInstallReviewPrincipal {
  const presentation = PluginInstallReviewPrincipalPresentationV1Schema.parse({
    v: 1,
    packageIdentity: {
      pluginId: review.pluginId,
      packageName: review.packageIdentity.name,
    },
    distributionIdentity: distributionIdentity(review),
  });
  const digest = derivePluginInstallReviewPrincipalDigest(presentation);
  return Object.freeze({ digest, presentation: Object.freeze(presentation) });
}

import { createHash } from 'node:crypto';

import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
  type PluginInstallReviewPrincipalDigest,
  type PluginInstallReviewPrincipalPresentationV1,
} from '@happier-dev/protocol';

import type { PluginInstallationReview } from './changeContract';

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

function publisherIdentity(
  review: PluginInstallationReview,
): PluginInstallReviewPrincipalPresentationV1['publisherIdentity'] {
  return Object.freeze({ ...review.publisherIdentity });
}

function packageSignature(
  review: PluginInstallationReview,
): PluginInstallReviewPrincipalPresentationV1['packageSignature'] {
  return review.signature.status === 'verified'
    ? { status: 'verified', keyId: review.signature.keyId }
    : { status: 'unavailable' };
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
 * Package version, artifact integrity, and runtime bytes are deliberately excluded:
 * an update by the same package/distribution/publisher/signature authority remains the same
 * reviewed principal, while changing any of those authority identities invalidates it.
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
    publisherIdentity: publisherIdentity(review),
    packageSignature: packageSignature(review),
  });
  const digest = derivePluginInstallReviewPrincipalDigest(presentation);
  return Object.freeze({ digest, presentation: Object.freeze(presentation) });
}

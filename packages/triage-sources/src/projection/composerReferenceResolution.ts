import type { ComposerReferenceResolutionV1 } from '@happier-dev/plugin-sdk';
import { ProtocolComposerReferenceResolutionV1Schema } from '@happier-dev/plugin-sdk/protocol';

type ComposerReferenceResolutionIdentityV1 = Readonly<{
  id: string;
  label: string;
  description?: string;
}>;

/**
 * Fits a whole-item prefix admitted by the canonical Composer reference-resolution
 * schema, preferring the complete context and otherwise searching prefix cardinality.
 *
 * The caller retains ownership of semantic item ordering and omission text.
 * This helper owns only the shared admission search, so providers neither copy
 * the 16 KiB boundary nor truncate provider-controlled strings.
 */
export function fitComposerReferenceResolutionPrefixV1(input: Readonly<{
  identity: ComposerReferenceResolutionIdentityV1;
  itemCount: number;
  contextForPrefix(includedItemCount: number): string;
}>): ComposerReferenceResolutionV1 | null {
  if (!Number.isSafeInteger(input.itemCount) || input.itemCount < 0) {
    throw new Error('Composer evidence itemCount must be a non-negative safe integer.');
  }
  const admit = (includedItemCount: number) => ProtocolComposerReferenceResolutionV1Schema.safeParse({
    ...input.identity,
    context: input.contextForPrefix(includedItemCount),
  });

  const complete = admit(input.itemCount);
  if (complete.success) return complete.data;

  let low = 0;
  let high = input.itemCount;
  while (low < high) {
    const candidateCount = Math.ceil((low + high) / 2);
    if (admit(candidateCount).success) low = candidateCount;
    else high = candidateCount - 1;
  }
  const fitted = admit(low);
  return fitted.success ? fitted.data : null;
}

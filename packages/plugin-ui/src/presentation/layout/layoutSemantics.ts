/**
 * The RN-free semantic vocabulary for Happier layout.
 *
 * Deliberately its own module with NO React Native import, for the same reason
 * as `presentation/semantics.ts`: the public layout adapter and the host's
 * declarative renderer both resolve the same gap words, so the shared
 * semantic-token-to-number decision must stay importable without pulling the
 * `react-native` entrypoint (whose Flow source an ordinary Node toolchain
 * cannot parse).
 */

export type HappierLayoutGap = 'none' | 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';

export type HappierLayoutSpacing = Readonly<Record<Exclude<HappierLayoutGap, 'none'>, number>>;

/** One semantic gap vocabulary for public and host declarative adapters. */
export function resolveHappierLayoutGap(
  gap: HappierLayoutGap | undefined,
  spacing: HappierLayoutSpacing,
): number {
  const resolvedGap = gap ?? 'medium';
  return resolvedGap === 'none' ? 0 : spacing[resolvedGap];
}

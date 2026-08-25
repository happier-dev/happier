export type SessionMediaImageDimensions = Readonly<{
  width: number;
  height: number;
}>;

function readPositiveImageDimension(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

/**
 * Best-effort SessionMedia image dimensions.
 *
 * Dimensions are optional, advisory metadata: a decoder that cannot read them (including
 * its own decoded-pixel defaults) must never make otherwise valid supported media invalid,
 * so this returns `null` instead of failing.
 */
export async function readSessionMediaImageDimensions(
  source: Buffer | string,
): Promise<SessionMediaImageDimensions | null> {
  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(source, { failOn: 'none' }).metadata();
    const width = readPositiveImageDimension(metadata.width);
    const height = readPositiveImageDimension(metadata.height);
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

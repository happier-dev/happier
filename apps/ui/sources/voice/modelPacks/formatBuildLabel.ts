import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

export function formatModelPackBuildLabel(
  manifest: Pick<ModelPackManifest, 'buildId' | 'publishedAt'> | null | undefined,
): string | null {
  const raw = typeof manifest?.buildId === 'string' && manifest.buildId.trim() ? manifest.buildId.trim() : null;
  const publishedAt = typeof manifest?.publishedAt === 'string' && manifest.publishedAt.trim() ? manifest.publishedAt.trim() : null;
  const value = raw ?? publishedAt;
  if (!value) return null;
  const isoPrefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  if (isoPrefix) return isoPrefix;
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}


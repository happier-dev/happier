export type DownloadProgressInfo = {
  percent: number | null;
  label: string | null;
  /** Transferred and expected bytes, when the source reports a byte total. */
  bytes: { loaded: number; total: number } | null;
  /** Completed and total files, when the source reports a multi-file transfer. */
  files: { done: number; total: number } | null;
  /** Bytes already checked against their expected hash, when the source verifies what it downloads. */
  verifiedBytes: number | null;
};

function clampPercent(x: number): number {
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

function lastPathSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseFileCounts(obj: Record<string, unknown>): DownloadProgressInfo['files'] {
  const done = obj?.filesDone;
  const total = obj?.filesTotal;
  if (!isFiniteNumber(done) || !isFiniteNumber(total) || total <= 0) return null;
  return { done: Math.min(Math.max(0, Math.floor(done)), total), total };
}

export function parseDownloadProgress(progress: unknown): DownloadProgressInfo {
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    const isFraction = progress >= 0 && progress <= 1;
    const percent = clampPercent(Math.floor((isFraction ? progress * 100 : progress) as number));
    return { percent, label: null, bytes: null, files: null, verifiedBytes: null };
  }

  if (!progress || typeof progress !== 'object') return { percent: null, label: null, bytes: null, files: null, verifiedBytes: null };

  const obj = progress as Record<string, unknown>;

  const rawName =
    typeof obj?.name === 'string'
      ? obj.name
      : typeof obj?.file === 'string'
        ? obj.file
        : typeof obj?.url === 'string'
          ? obj.url
          : null;
  const label = rawName ? lastPathSegment(rawName) || rawName.trim() : null;

  const files = parseFileCounts(obj);

  const loaded = obj?.loaded;
  const total = obj?.total;
  if (isFiniteNumber(loaded) && isFiniteNumber(total) && total > 0) {
    const percent = clampPercent(Math.floor((loaded / total) * 100));
    const verified = obj?.verified;
    const verifiedBytes = isFiniteNumber(verified) ? Math.min(Math.max(0, verified), total) : null;
    return { percent, label, bytes: { loaded: Math.min(Math.max(0, loaded), total), total }, files, verifiedBytes };
  }

  const rawProgress = obj?.progress;
  if (isFiniteNumber(rawProgress)) {
    const isFraction = rawProgress >= 0 && rawProgress <= 1;
    const percent = clampPercent(Math.floor((isFraction ? rawProgress * 100 : rawProgress) as number));
    return { percent, label, bytes: null, files, verifiedBytes: null };
  }

  return { percent: null, label, bytes: null, files, verifiedBytes: null };
}

export function formatDownloadProgressDetail(progress: unknown, opts?: { prefix?: string }): string {
  const { percent, label } = parseDownloadProgress(progress);

  const parts: string[] = [];
  if (opts?.prefix) parts.push(opts.prefix);
  if (percent != null) parts.push(`${percent}%`);
  if (label) parts.push(label);

  if (parts.length === 0) return 'Downloading…';
  return parts.join(' • ');
}

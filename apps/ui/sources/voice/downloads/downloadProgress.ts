export type DownloadProgressInfo = {
  percent: number | null;
  label: string | null;
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

export function parseDownloadProgress(progress: unknown): DownloadProgressInfo {
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    const isFraction = progress >= 0 && progress <= 1;
    const percent = clampPercent(Math.floor((isFraction ? progress * 100 : progress) as number));
    return { percent, label: null };
  }

  if (!progress || typeof progress !== 'object') return { percent: null, label: null };

  const obj = progress as any;

  const rawName =
    typeof obj?.name === 'string'
      ? obj.name
      : typeof obj?.file === 'string'
        ? obj.file
        : typeof obj?.url === 'string'
          ? obj.url
          : null;
  const label = rawName ? lastPathSegment(rawName) || rawName.trim() : null;

  const loaded = obj?.loaded;
  const total = obj?.total;
  if (typeof loaded === 'number' && Number.isFinite(loaded) && typeof total === 'number' && Number.isFinite(total) && total > 0) {
    const percent = clampPercent(Math.floor((loaded / total) * 100));
    return { percent, label };
  }

  const rawProgress = obj?.progress;
  if (typeof rawProgress === 'number' && Number.isFinite(rawProgress)) {
    const isFraction = rawProgress >= 0 && rawProgress <= 1;
    const percent = clampPercent(Math.floor((isFraction ? rawProgress * 100 : rawProgress) as number));
    return { percent, label };
  }

  return { percent: null, label };
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

import { RollingNumber } from './RollingNumber';
import { formatStatCount, readCount, statsUrl, usePublicStat } from './publicStats';

/** Measured 2026-08-04; only shown until the published stats load. */
const FALLBACK_DOWNLOAD_TOTAL = 35020;

type DownloadStatsPayload = {
    totalDownloads: number;
};

export function parseDownloadStats(value: unknown): DownloadStatsPayload | null {
    const totalDownloads = readCount(value, 'totalDownloads');
    if (totalDownloads === null) return null;
    return { totalDownloads };
}

type DownloadStatsProps = {
    className?: string;
    fallbackTotal?: number;
    url?: string;
};

export function DownloadStats({
    className = '',
    fallbackTotal = FALLBACK_DOWNLOAD_TOTAL,
    url = import.meta.env.VITE_DOWNLOAD_STATS_URL ?? statsUrl('downloads.json'),
}: DownloadStatsProps) {
    const { totalDownloads } = usePublicStat(url, parseDownloadStats, {
        totalDownloads: fallbackTotal,
    });

    return (
        <span
            className={`inline-flex items-center whitespace-nowrap text-[13px] font-medium leading-none md:text-[14px] ${className}`}
            style={{ color: 'var(--muted)' }}
            title={`${formatStatCount(totalDownloads)} downloads`}
        >
            <RollingNumber value={formatStatCount(totalDownloads)} />
            <span className="ml-1">downloads</span>
        </span>
    );
}

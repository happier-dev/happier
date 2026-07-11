import { useEffect, useState } from 'react';

const DEFAULT_DOWNLOAD_STATS_URL = 'https://stats.happier.dev/downloads.json';
const FALLBACK_DOWNLOAD_TOTAL = 21794;

type DownloadStatsPayload = {
    totalDownloads: number;
};

export function parseDownloadStats(value: unknown): DownloadStatsPayload | null {
    if (!value || typeof value !== 'object') return null;
    const totalDownloads = (value as { totalDownloads?: unknown }).totalDownloads;
    if (!Number.isFinite(totalDownloads) || typeof totalDownloads !== 'number' || totalDownloads < 0) return null;
    return { totalDownloads: Math.floor(totalDownloads) };
}

export function formatDownloadCount(totalDownloads: number): string {
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: totalDownloads >= 10_000 ? 1 : 0,
        notation: totalDownloads >= 10_000 ? 'compact' : 'standard',
    }).format(totalDownloads);
}

type DownloadStatsProps = {
    className?: string;
    fallbackTotal?: number;
    statsUrl?: string;
};

export function DownloadStats({
    className = '',
    fallbackTotal = FALLBACK_DOWNLOAD_TOTAL,
    statsUrl = import.meta.env.VITE_DOWNLOAD_STATS_URL ?? DEFAULT_DOWNLOAD_STATS_URL,
}: DownloadStatsProps) {
    const [totalDownloads, setTotalDownloads] = useState(fallbackTotal);

    useEffect(() => {
        let cancelled = false;

        async function loadStats() {
            try {
                const response = await fetch(statsUrl);
                if (!response.ok) return;
                const parsed = parseDownloadStats(await response.json());
                if (!cancelled && parsed) setTotalDownloads(parsed.totalDownloads);
            } catch {
                /* Keep the static fallback when public stats are unavailable. */
            }
        }

        loadStats();

        return () => {
            cancelled = true;
        };
    }, [statsUrl]);

    const formatted = formatDownloadCount(totalDownloads);

    return (
        <span
            className={`inline-flex items-center whitespace-nowrap text-[13px] font-medium leading-none md:text-[14px] ${className}`}
            style={{ color: 'var(--muted)' }}
            aria-label={`${totalDownloads.toLocaleString('en-US')} downloads`}
            title={`${totalDownloads.toLocaleString('en-US')} downloads`}
        >
            {formatted} downloads
        </span>
    );
}

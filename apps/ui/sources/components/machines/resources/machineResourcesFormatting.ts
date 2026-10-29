import { formatByteSize } from '@/utils/files/formatByteSize';

/** Used/total pair for a gauge's secondary line (e.g. `5.2 GB / 16.0 GB`). */
export function formatMachineResourcesByteRange(usedBytes: number, totalBytes: number): string {
    return `${formatByteSize(usedBytes)} / ${formatByteSize(totalBytes)}`;
}

/**
 * Width-saving used/total pair for inline strip metrics (e.g. `5.2/16 GB`): one shared unit —
 * derived from the total — instead of restating it per side.
 */
export function formatMachineResourcesByteRangeCompact(usedBytes: number, totalBytes: number): string {
    const total = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
    const used = Number.isFinite(usedBytes) ? Math.max(0, usedBytes) : 0;

    let divisor = 1;
    let unit = 'B';
    if (total >= 1024 ** 4) {
        divisor = 1024 ** 4;
        unit = 'TB';
    } else if (total >= 1024 ** 3) {
        divisor = 1024 ** 3;
        unit = 'GB';
    } else if (total >= 1024 ** 2) {
        divisor = 1024 ** 2;
        unit = 'MB';
    } else if (total >= 1024) {
        divisor = 1024;
        unit = 'KB';
    }

    const formatSide = (value: number): string => {
        const scaled = value / divisor;
        const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    };
    return `${formatSide(used)}/${formatSide(total)} ${unit}`;
}

import { describe, expect, it } from 'vitest';
import { formatDownloadCount, parseDownloadStats } from './DownloadStats';

describe('download stats', () => {
    it('formats the public download total compactly', () => {
        expect(formatDownloadCount(21791)).toBe('21.8K');
        expect(formatDownloadCount(999)).toBe('999');
    });

    it('accepts the minimal public stats payload', () => {
        expect(parseDownloadStats({ totalDownloads: 21791 })).toEqual({ totalDownloads: 21791 });
        expect(parseDownloadStats({ totalDownloads: -1 })).toBeNull();
        expect(parseDownloadStats({ totalDownloads: '21791' })).toBeNull();
    });
});

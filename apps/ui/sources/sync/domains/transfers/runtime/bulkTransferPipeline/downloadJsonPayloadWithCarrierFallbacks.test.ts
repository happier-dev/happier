import { describe, expect, it, vi } from 'vitest';

import { downloadJsonPayloadWithCarrierFallbacks } from './downloadJsonPayloadWithCarrierFallbacks';

describe('downloadJsonPayloadWithCarrierFallbacks', () => {
    it('falls back to relay and legacy carriers when an earlier carrier throws', async () => {
        const directExport = vi.fn(async () => {
            throw new Error('direct export unavailable');
        });
        const relay = vi.fn(async () => ({ ok: true as const, payload: { source: 'relay' } }));
        const legacy = vi.fn(async () => ({ ok: true as const, payload: { source: 'legacy' } }));

        const result = await downloadJsonPayloadWithCarrierFallbacks({
            downloadViaDirectExport: directExport,
            downloadViaServerRelay: relay,
            downloadViaLegacyBulk: legacy,
        });

        expect(result).toEqual({ ok: true, payload: { source: 'relay' } });
        expect(directExport).toHaveBeenCalledTimes(1);
        expect(relay).toHaveBeenCalledTimes(1);
        expect(legacy).not.toHaveBeenCalled();
    });

    it('falls back to legacy when direct export and relay carriers throw', async () => {
        const directExport = vi.fn(async () => {
            throw new Error('direct export unavailable');
        });
        const relay = vi.fn(async () => {
            throw new Error('relay unavailable');
        });
        const legacy = vi.fn(async () => ({ ok: true as const, payload: { source: 'legacy' } }));

        const result = await downloadJsonPayloadWithCarrierFallbacks({
            downloadViaDirectExport: directExport,
            downloadViaServerRelay: relay,
            downloadViaLegacyBulk: legacy,
        });

        expect(result).toEqual({ ok: true, payload: { source: 'legacy' } });
        expect(directExport).toHaveBeenCalledTimes(1);
        expect(relay).toHaveBeenCalledTimes(1);
        expect(legacy).toHaveBeenCalledTimes(1);
    });
});

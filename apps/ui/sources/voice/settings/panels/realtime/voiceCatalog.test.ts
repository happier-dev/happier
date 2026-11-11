import { describe, expect, it } from 'vitest';
import { readVoiceCatalogSettingsActionResult } from './voiceCatalog';

describe('Voice catalog Action failures', () => {
    it('preserves the typed Action cause and recovery details', () => {
        const details = { credentialSlotId: 'api_key' };
        expect(() => readVoiceCatalogSettingsActionResult({ ok: false, errorCode: 'credential_unavailable',
            error: 'Credential required', details })).toThrow(expect.objectContaining({
                code: 'credential_unavailable', message: 'Credential required', details,
            }));
    });
    it('preserves a typed unavailable Settings receipt', () => {
        expect(() => readVoiceCatalogSettingsActionResult({ ok: true, result: {
            anchor: 'voice.catalog', status: 'unavailable', reason: 'credential_unavailable',
        } })).toThrow(expect.objectContaining({ code: 'credential_unavailable' }));
    });
    it('keeps the generic fallback for receipts with no typed cause', () => {
        expect(() => readVoiceCatalogSettingsActionResult({ ok: true, result: {
            anchor: 'voice.catalog', status: 'unavailable',
        } })).toThrow('voice_catalog_unavailable');
    });
});

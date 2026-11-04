import { describe, expect, it } from 'vitest';
import { publishHomeAccountChangeForRouting } from './homeAccountChange';

describe('Home Account change subscriptions', () => {
    it('routes Session-only wakes without waking unrelated Home catalogs', () => {
        const event = publishHomeAccountChangeForRouting('session-home', ['session-a'], {
            source: 'socket', changeKinds: ['session'], sessionSystemRecords: [] });
        expect(event).toMatchObject({ accountSettingsAffects: false, profileCatalogAffects: false,
            workflowTriggersAffect: false, workflowDefinitionsAffect: false });
        // Kind-only routing cannot exclude Session accounting without a detailed hint.
        expect(event.usageQueryAffects).toBe(true);
        expect(publishHomeAccountChangeForRouting('session-home', undefined, { source: 'socket' }))
            .toMatchObject({ accountSettingsAffects: true, workflowTriggersAffect: true });
        expect(publishHomeAccountChangeForRouting('session-home', ['unknown-plugin'], {
            source: 'socket', changeKinds: ['pluginDomain'] }).workflowTriggersAffect).toBe(true);
    });
});

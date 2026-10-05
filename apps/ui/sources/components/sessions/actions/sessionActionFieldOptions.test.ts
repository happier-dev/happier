import { describe, expect, it } from 'vitest';
import { buildSessionActionFieldOptionsHeightSignature, buildSessionActionFieldOptionsResolver } from './sessionActionFieldOptions';

describe('resolved input options paint projection', () => {
    it('paints any admitted source without a local source allowlist', () => {
        const channels = [{ value: 'phone', label: 'Phone', description: 'Push', disabled: true }];
        const resolve = buildSessionActionFieldOptionsResolver({ 'notifications.channels.available': channels });
        expect(resolve({ optionsSourceId: 'notifications.channels.available' })).toBe(channels);
        const staticOptions = [{ value: 'all', label: 'All changes' }];
        expect(resolve({ options: staticOptions })).toBe(staticOptions);
    });

    it('only changes height for painted content, not availability', () => {
        const signature = buildSessionActionFieldOptionsHeightSignature;
        const base = { source: [{ value: 'engine', label: 'Engine', description: 'Review' }] };
        expect(signature({ source: [{ ...base.source[0]!, disabled: true }] })).toBe(signature(base));
        expect(signature({ source: [{ ...base.source[0]!, label: 'New title' }] })).not.toBe(signature(base));
        expect(signature({ source: [{ ...base.source[0]!, description: 'New detail' }] })).not.toBe(signature(base));
        expect(signature({ source: [...base.source, { value: 'new', label: 'New engine' }] })).not.toBe(signature(base));
    });

    it('uses semantic Connected Account identity in height keys', () => {
        const account = { service: { pluginId: 'com.acme.accounts', localId: 'service' }, accountId: 'account-1' };
        const signature = buildSessionActionFieldOptionsHeightSignature;
        expect(signature({ source: [{ value: account, label: 'Account' }] })).toBe(
            signature({ source: [{ value: { ...account, service: { ...account.service } }, label: 'Account' }] }),
        );
        expect(signature({ source: [{ value: account, label: 'Account' }] })).not.toBe(
            signature({ source: [{ value: { ...account, accountId: 'account-2' }, label: 'Account' }] }),
        );
    });
});

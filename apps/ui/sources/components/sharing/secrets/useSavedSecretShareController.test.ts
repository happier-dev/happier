import { describe, expect, it } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useSavedSecretShareController } from './useSavedSecretShareController';

describe('Saved Secret principal presentation', () => {
    it('identifies a named current person consistently and keeps an unknown person anonymous by kind', async () => {
        const scope = { serverId: 'home-secret-identity', accountId: 'owner' };
        getStorage().setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: 'owner', firstName: 'Avery', lastName: 'Owner' }) });
        const hook = await renderHook(() => useSavedSecretShareController({ scope, disabled: false, onChange() {},
            draft: [{ kind: 'account', accountId: 'owner' }, { kind: 'account', accountId: 'unknown-person-id' }],
            retainedAudience: { accounts: [{ kind: 'account', accountId: 'owner', firstName: 'Avery', lastName: 'Owner', username: null, avatarUrl: null }], teams: [], groups: [] },
        }));
        expect(hook.getCurrent().model.grants[0].principal.displayName).toBe('Avery Owner');
        expect(hook.getCurrent().model.grants[0].principal.secondaryLabel).toBe(t('shareSheet.you'));
        expect(hook.getCurrent().model.grants[1].principal.displayName).toBe(t('accountDisplay.unnamed'));
        expect(hook.getCurrent().model.grants[1].principal.accessibilityLabel).not.toContain('unknown-person-id');
        await hook.unmount();
    });
});

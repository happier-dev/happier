import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { getSessionName, resolveLockedSessionTitle } from './sessionUtils';

describe('resolveLockedSessionTitle', () => {
    it('keeps a safe cached title while encrypted access is still pending', () => {
        // Encryption pending is not a reason to forget a name this device already holds.
        expect(resolveLockedSessionTitle('Refactor the payments importer'))
            .toBe('Refactor the payments importer');
    });

    it('names an encrypted Session instead of reporting it as unknown', () => {
        // Use the display owner's actual fallback, not a runtime-status label.
        const unnamedSession = createSessionFixture({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            metadata: null,
        });
        expect(resolveLockedSessionTitle(getSessionName(unnamedSession)))
            .toBe(t('session.access.lockedTitleFallback'));
        expect(resolveLockedSessionTitle('   ')).toBe(t('session.access.lockedTitleFallback'));
        expect(resolveLockedSessionTitle('')).toBe(t('session.access.lockedTitleFallback'));
    });
});

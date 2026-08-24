import { afterEach, describe, expect, it } from 'vitest';

import { mintTriageOpaqueIdV1 } from './opaqueId.js';
import {
    TRIAGE_SAVED_VIEWS_SETTING_ID_V1,
    mutateTriageSavedViews,
    readTriageSavedViews,
} from './settings/savedViews.js';
import { createTestkitAccountSettings } from './settings/testkit/accountSettings.test-support.js';

/**
 * The one opaque-id owner, proved where its shape is load-bearing.
 *
 * A saved view is read back through a UUID pattern. A view minted in any other
 * spelling is written successfully and then makes the WHOLE saved-view value
 * unreadable on the next read — every one of the reader's views gone, with no
 * upstream owner to recover them from. So this is not a formatting preference:
 * it is the difference between a device with no WebCrypto being able to save a
 * view and destroying the set the first time it tries.
 */

const realCrypto = globalThis.crypto;

function withoutWebCrypto<T>(run: () => T): T {
    // The React Native case, which is the only one the fallback exists for.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
        return run();
    } finally {
        Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    }
}

afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
});

const LENS = {
    filters: { sources: [], types: [], scopes: [], states: ['open'], attention: ['required'] },
    order: 'smart',
    smartPolicy: { v: 1, precedence: ['attention', 'activity'] },
} as const;

describe('the Triage opaque-id owner', () => {
    it('mints distinct ids', () => {
        const minted = new Set(Array.from({ length: 64 }, () => mintTriageOpaqueIdV1()));
        expect(minted.size).toBe(64);
    });

    it('mints a saved view that the saved-views owner can read back on a runtime with no WebCrypto', async () => {
        const accountSettings = createTestkitAccountSettings();
        const deps = {
            settings: accountSettings.settings,
            mintViewId: () => withoutWebCrypto(() => mintTriageOpaqueIdV1()),
        };

        const written = await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: accountSettings.revision(),
            label: 'Needs me',
            ...LENS,
            select: true,
        });
        expect(written.status).toBe('applied');

        // The deciding assertion: the value this build wrote is a value this
        // build can read. `unreadable` here would mean the reader has silently
        // lost every saved view they had.
        const read = await readTriageSavedViews({ settings: accountSettings.settings });
        expect(read.kind).toBe('parsed');
        expect(read.value.views.map((view) => view.label)).toEqual(['Needs me']);
        expect(read.value.selectedViewId).toBe(read.value.views[0]?.viewId);
        expect(accountSettings.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1)).toBeDefined();
    });
});

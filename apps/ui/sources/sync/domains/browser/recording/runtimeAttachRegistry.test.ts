import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserRecordingAttachAdapter } from './runtimeAttachExecutor';
import type { BrowserRecordingState } from './types';
import {
    clearBrowserRecordingAttachRegistryForTests,
    readRegisteredBrowserRecordingAttachAdapter,
    registerBrowserRecordingAttachAdapter,
} from './runtimeAttachRegistry';

const emptyRecordingState: BrowserRecordingState = {
    sessionsById: {},
    sessionOrder: [],
    activeRecordingIdByViewId: {},
    attachmentsById: {},
    attachmentOrder: [],
};

function makeAdapter(): BrowserRecordingAttachAdapter {
    return {
        attach: () => ({
            status: 'unavailable',
            state: emptyRecordingState,
            reason: {
                reasonCode: 'browser_recording_missing',
                policyState: 'policyDenied',
                message: 'missing',
            },
        }),
    };
}

afterEach(() => {
    clearBrowserRecordingAttachRegistryForTests();
});

describe('browser recording attach registry (UX-7 keyed map)', () => {
    it('keeps distinct adapters per (browserSessionId, viewId) without eviction', () => {
        const adapterA = makeAdapter();
        const adapterB = makeAdapter();
        registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: adapterA,
        });
        registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: adapterB,
        });

        expect(
            readRegisteredBrowserRecordingAttachAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBe(adapterA);
        expect(
            readRegisteredBrowserRecordingAttachAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_b',
            }),
        ).toBe(adapterB);
    });

    it('returns the sole registered owner when no view key is supplied', () => {
        const adapter = makeAdapter();
        registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter,
        });
        expect(readRegisteredBrowserRecordingAttachAdapter()).toBe(adapter);
    });

    it('returns null (no misroute) when ambiguous and no key is supplied', () => {
        registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: makeAdapter(),
        });
        registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: makeAdapter(),
        });
        expect(readRegisteredBrowserRecordingAttachAdapter()).toBeNull();
    });

    it('unregister only clears its own slot (token-checked)', () => {
        const adapterA = makeAdapter();
        const adapterB = makeAdapter();
        const disposeA = registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: adapterA,
        });
        registerBrowserRecordingAttachAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: adapterB,
        });

        disposeA();

        expect(
            readRegisteredBrowserRecordingAttachAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBeNull();
        expect(
            readRegisteredBrowserRecordingAttachAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_b',
            }),
        ).toBe(adapterB);
    });
});

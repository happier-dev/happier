import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '@/modal';
// Load the real Run body during collection; module transformation is outside selector settlement.
import '@/components/sessions/runs/launcher/reviewExecutionRunLaunchSelection';
import { createDeferred } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginActionInputSelector } from './pluginActionInputSelectionHostApi';

afterEach(() => {
    retireActiveServerAccountScopeLifetime();
    storage.setState(storage.getInitialState(), true);
    vi.restoreAllMocks();
});

describe('host selector Account retirement', () => {
    it.each(['session.transcript.get', 'review.start', 'session.spawn_new'] as const)(
        'keeps an open %s selector until dismissal and checks its captured Account at settlement', async action => {
            publishAppliedActiveServerSnapshot({ serverId: 'srv_selector', serverUrl: 'https://selector.example', generation: 0 });
            storage.setState({ profileScope: { serverId: 'srv_selector', accountId: 'account-a' } });
            const accountLifetime = captureActiveServerAccountScopeLifetime();
            if (!accountLifetime) throw new Error('Expected the real captured Account lifetime');
            const shown = createDeferred<void>();
            let dismiss: (() => void) | undefined;
            vi.spyOn(Modal, 'show').mockImplementation(config => {
                dismiss = config.onRequestClose;
                shown.resolve();
                return 'selector';
            });
            const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
            const select = createPluginActionInputSelector({ host: {
                serverId: 'srv_selector', machineId: 'machine-a', targetPluginId: 'acme.selector', accountLifetime,
            }, isCurrent: () => true });
            const hostAction = action === 'session.transcript.get'
                ? { action, projection: 'sessionAddress' }
                : action === 'review.start'
                    ? { action, projection: 'executionRunLaunch' }
                    : { action, projection: 'serverStartDraft' };
            const pending = select({ hostAction, ...(action === 'review.start' ? { sessionId: 'session-a', draft: { engineIds: ['claude'], instructions: 'Review this change' } } : {}) });
            try {
                await Promise.race([shown.promise, pending.then(result => { throw new Error(`Selector settled before presentation: ${JSON.stringify(result)}`); })]);
                retireActiveServerAccountScopeLifetime();
                expect(hide).not.toHaveBeenCalled();
                dismiss?.();
                expect(hide).toHaveBeenCalledWith('selector');
                expect(await pending).toMatchObject({ code: 'stale_surface' });
            } finally {
                dismiss?.();
                await pending;
            }
        },
    );
});

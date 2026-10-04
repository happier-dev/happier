import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiHostApiRequestEnvelopeV1, PluginUiSelectActionInputResultV1 } from '@happier-dev/protocol/plugins/ui';

import { Modal } from '@/modal';
import { createDeferred } from '@/dev/testkit';

import { createPluginActionInputSelectionHostApiHandler } from './pluginActionInputSelectionHostApi';

type LaunchSelection = Extract<PluginUiSelectActionInputResultV1, { kind: 'executionRunLaunch' }>;
const accountLifetime = { scope: { serverId: 'source-home', accountId: 'source-account' },
    isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
function reviewRequest(): PluginUiHostApiRequestEnvelopeV1 {
    return { version: 1, requestId: 'review-selection', surface: {
        pluginId: 'acme.triage', contributionId: 'triage', surfaceId: 'triage-app',
        placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
    }, method: 'selectActionInput', payload: {
        hostAction: { action: 'review.start', projection: 'executionRunLaunch' },
        sessionId: 'prepared-session', serverId: 'session-home',
        draft: { engineIds: ['claude'], instructions: 'Review the selected PR' },
    } };
}
function mount() {
    const controller = new AbortController();
    const handler = createPluginActionInputSelectionHostApiHandler({
        host: { machineId: 'source-machine', serverId: 'source-home', targetPluginId: 'acme.triage',
            accountLifetime, signal: controller.signal }, isCurrent: () => !controller.signal.aborted,
    });
    return { handler, controller };
}
afterEach(() => vi.restoreAllMocks());

describe('host review launch selection lifecycle', () => {
    it('refuses an unbound source Account before native presentation', async () => {
        const show = vi.spyOn(Modal, 'show').mockImplementation((config) => {
            config.onRequestClose?.();
            return 'review-modal';
        });
        vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const handler = createPluginActionInputSelectionHostApiHandler({ host: {
            machineId: 'source-machine', serverId: 'source-home', targetPluginId: 'acme.triage',
        }, isCurrent: () => true });
        expect(await handler(reviewRequest())).toEqual({ code: 'unavailable', diagnostics: ['host_unavailable'] });
        expect(show).not.toHaveBeenCalled();
    });

    it('presents the exact requested Session/Home rather than the source surface target and returns only selected references', async () => {
        const shown = createDeferred<{ sessionId: string; serverId: string; onResolve: (result: LaunchSelection | null) => void }>();
        // Native presentation is the genuine user/system boundary. The production
        // component beneath it uses the real shared controls and launch admission.
        vi.spyOn(Modal, 'show').mockImplementation((config) => {
            shown.resolve(config.props as { sessionId: string; serverId: string; onResolve: (result: LaunchSelection | null) => void });
            return 'review-modal';
        });
        vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const { handler } = mount();
        const selecting = handler(reviewRequest());
        const presentation = await shown.promise;
        expect(presentation).toMatchObject({ sessionId: 'prepared-session', serverId: 'session-home' });
        const result: LaunchSelection = { kind: 'executionRunLaunch', input: {
            secretReferenceOverlay: { v: 1, bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:selected-key', revision: 7 } } },
        } };
        presentation.onResolve(result);
        expect(await selecting).toEqual(result);
    });

    it('settles user dismissal as cancellation without an Action-selection authority handle', async () => {
        vi.spyOn(Modal, 'show').mockImplementation((config) => {
            config.onRequestClose?.();
            return 'review-modal';
        });
        vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        expect(await mount().handler(reviewRequest())).toEqual({ kind: 'cancelled' });
    });

    it('withdraws pending selection when the source mount retires and withholds its result', async () => {
        const shown = createDeferred<void>();
        vi.spyOn(Modal, 'show').mockImplementation(() => { shown.resolve(); return 'review-modal'; });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const { handler, controller } = mount();
        const selecting = handler(reviewRequest());
        await shown.promise;
        controller.abort();
        expect(await selecting).toEqual({ code: 'stale_surface', diagnostics: ['select_action_input_aborted'] });
        expect(hide).toHaveBeenCalledWith('review-modal');
    });
});

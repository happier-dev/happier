import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateContributedActionSessionAddressV1 } from '@happier-dev/protocol/actions/executor/sessionTargets';
import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import { Modal } from '@/modal';
import { createDeferred } from '@/dev/testkit';

import { createPluginActionInputSelectionHostApiHandler } from './pluginActionInputSelectionHostApi';

const anchor = { kind: 'rect', rect: { left: 20, top: 30, width: 80, height: 32 } } as const;
const request: PluginUiHostApiRequestEnvelopeV1 = { version: 1, requestId: 'session-reference', surface: {
    pluginId: 'acme.pr', contributionId: 'pr', surfaceId: 'project-pr', placement: 'appSurface',
    platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
}, method: 'selectActionInput', payload: { hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } } };

function mount() {
    const controller = new AbortController();
    const lifetime = { scope: { serverId: 'server-a', accountId: 'account-a' }, isCurrent: () => !controller.signal.aborted,
        onRetire: () => ({ dispose() {} }) };
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'server-a', machineId: 'machine-a', targetPluginId: 'acme.pr', accountLifetime: lifetime, signal: controller.signal,
    }, isCurrent: lifetime.isCurrent, anchor });
    return { handler, controller, lifetime };
}
afterEach(() => vi.restoreAllMocks());

describe('mounted Session address selection', () => {
    it('returns the exact chosen address through native selection, without invoking an Action', async () => {
        const shown = createDeferred<{ sourceServerId: string; selectionOnly: true; onResolve: (selection: unknown) => void }>();
        // Modal presentation is the real person/platform boundary; selection admission remains real.
        const show = vi.spyOn(Modal, 'show').mockImplementation(config => { shown.resolve(config.props as Awaited<typeof shown.promise>); return 'picker'; });
        vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const mounted = mount();
        const selecting = mounted.handler(request);
        const props = await shown.promise;
        expect(show.mock.calls[0]?.[0].chrome).toMatchObject({ phonePresentation: 'sheet', anchor });
        expect(props).toMatchObject({ sourceServerId: 'server-a', selectionOnly: true });
        props.onResolve({ kind: 'existingSession', serverId: 'server-a', sessionId: 'chosen' });
        const sessionAddress = { serverId: 'server-a', sessionId: 'chosen' };
        expect(await selecting).toEqual({ kind: 'sessionAddress', session: sessionAddress });
        expect(validateContributedActionSessionAddressV1({ sessionAddress: JSON.parse(JSON.stringify(sessionAddress)),
            selectionScope: mounted.lifetime, callerPluginId: 'acme.pr' })).toEqual({ ok: true, sessionAddress });
        expect(validateContributedActionSessionAddressV1({ sessionAddress, selectionScope: mount().lifetime,
            callerPluginId: 'acme.pr' })).toMatchObject({ ok: false, errorCode: 'session_address_unsupported' });
        expect(validateContributedActionSessionAddressV1({ sessionAddress, selectionScope: mounted.lifetime,
            callerPluginId: 'acme.other' })).toMatchObject({ ok: false, errorCode: 'session_address_unsupported' });
    });

    it('retires the native picker on cancellation', async () => {
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const shownAgain = createDeferred<void>();
        vi.spyOn(Modal, 'show').mockImplementation(() => { shownAgain.resolve(); return 'picker-again'; });
        const pending = mount();
        const aborted = pending.handler(request);
        await shownAgain.promise;
        pending.controller.abort();
        expect(await aborted).toMatchObject({ code: 'stale_surface' });
        expect(hide).toHaveBeenCalledWith('picker-again');
    });

    it('does not open a native picker for an unbound Account or caller-supplied Home override', async () => {
        const show = vi.spyOn(Modal, 'show');
        const unbound = createPluginActionInputSelectionHostApiHandler({ host: {
            serverId: 'server-a', machineId: 'machine-a', targetPluginId: 'acme.pr',
        }, isCurrent: () => true });
        expect(await unbound(request)).toMatchObject({ code: 'unavailable' });
        expect(await mount().handler({ ...request, payload: {
            hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' }, serverId: 'another-home',
        } })).toMatchObject({ code: 'invalid_payload' });
        expect(show).not.toHaveBeenCalled();
    });
});

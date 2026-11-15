import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui/client';
import type { PluginUiHostApiWireEnvelopeV1 } from '@happier-dev/protocol/plugins/ui/client';
import { PLUGIN_UI_HOST_METHODS_V1, PluginUiActionControlEventV1Schema, PluginUiActionControlRequestV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import { createPluginUiHostApiClientFromTransport } from './clientTransport.js';
import { PluginError } from '../errors.js';

const identity = { instanceId: 'control-mount', mountNonce: 'control-nonce' } as const;

async function fixture(supported = true, holdPrepared = false) {
    let receive: ((message: unknown) => void) | undefined;
    let preparedRequest: Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' }> | undefined;
    const sent: PluginUiHostApiWireEnvelopeV1[] = [];
    const api = await createPluginUiHostApiClientFromTransport({ identity, transport: {
        subscribe(listener) { receive = listener; return { dispose() {} }; },
        send(message) {
            sent.push(message);
            if (message.kind === 'negotiate') receive?.({ wireVersion: 1, kind: 'negotiated', identity,
                apiVersion: PLUGIN_UI_HOST_API_VERSION_V1, methods: supported ? PLUGIN_UI_HOST_METHODS_V1 : ['context'] });
            if (holdPrepared && message.kind === 'request' && message.method === 'actionControl'
                && message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
                && 'kind' in message.payload && message.payload.kind === 'prepared') { preparedRequest = message; return; }
            if (message.kind === 'subscribe' || message.kind === 'request') receive?.({ wireVersion: 1,
                kind: 'result', identity, requestId: message.requestId, method: message.method, result: null });
        },
    } });
    const event = (value: unknown) => {
        const subscription = sent.find(message => message.kind === 'subscribe');
        if (!subscription || subscription.kind !== 'subscribe') throw new Error('No control subscription');
        receive?.({ wireVersion: 1, kind: 'subscription', identity, subscriptionId: subscription.subscriptionId, event: value });
    };
    return { api, sent, event, settlePrepared(execution: unknown) {
        if (!preparedRequest) throw new Error('No admitted preparation');
        receive?.({ wireVersion: 1, kind: 'result', identity, requestId: preparedRequest.requestId,
            method: preparedRequest.method, result: execution });
    }, refusePrepared() {
        if (!preparedRequest) throw new Error('No admitted preparation');
        receive?.({ wireVersion: 1, kind: 'error', identity, requestId: preparedRequest.requestId,
            method: preparedRequest.method, error: new PluginError({ code: 'unavailable', message: 'unavailable', retryable: false }).data });
    } };
}

describe('mounted host Action control', () => {
    it('prepares once per host request, returns correlated input, and forwards unknown settlement without replay', async () => {
        const { api, sent, event } = await fixture();
        const prepare = vi.fn(() => ({ input: { current: 1 } }));
        const onSettled = vi.fn();
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, { prepare, onSettled });
        expect(prepare).not.toHaveBeenCalled();
        event({ kind: 'prepare', requestId: 'gesture-1' });
        await vi.waitFor(() => expect(sent.filter(message => message.kind === 'request' && message.method === 'actionControl')).toHaveLength(1));
        expect(sent).toContainEqual(expect.objectContaining({ kind: 'request', payload: {
            kind: 'prepared', subscriptionId: expect.any(String), requestId: 'gesture-1', preparation: { input: { current: 1 } },
        } }));
        const execution = { ok: false, errorCode: 'indeterminate', error: 'Acceptance unknown', details: { operationId: 'original-operation' } };
        event({ kind: 'settled', requestId: 'gesture-1', execution });
        expect(onSettled).toHaveBeenCalledExactlyOnceWith(execution);
        expect(prepare).toHaveBeenCalledTimes(1);
        await control.update({ title: 'Run again', disabled: true });
        await control.dispose();
    });

    it.each(['dispose', 'withdrawal', 'stop'] as const)('aborts %s preparation and never submits its late input', async (retirement) => {
        const { api, sent, event } = await fixture();
        const cancellation = new AbortController();
        let finish: ((value: { input: string }) => void) | undefined;
        let signal: AbortSignal | undefined;
        const prepare = vi.fn((options: { signal: AbortSignal }) => {
            signal = options.signal;
            return new Promise<{ input: string }>(resolve => { finish = resolve; });
        });
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, { prepare, onSettled() {} }, {
            ...(retirement === 'stop' ? { signal: cancellation.signal } : {}),
            ...(retirement === 'withdrawal' ? { withdrawalSignal: cancellation.signal } : {}),
        });
        event({ kind: 'prepare', requestId: 'gesture-retired' });
        if (retirement === 'dispose') await control.dispose();
        else cancellation.abort();
        expect(signal?.aborted).toBe(true);
        finish?.({ input: 'late' });
        await Promise.resolve();
        expect(sent.filter(message => message.kind === 'request' && message.method === 'actionControl')).toEqual([]);
        await control.dispose();
    });

    it('withdraws the control while delivering its admitted execution to the original controller exactly once', async () => {
        const { api, sent, event, settlePrepared } = await fixture(true, true);
        const prepare = vi.fn(() => ({ input: { saved: true } }));
        const onSettled = vi.fn();
        const withdrawal = new AbortController();
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Save' } },
            { prepare, onSettled }, { withdrawalSignal: withdrawal.signal });
        event({ kind: 'prepare', requestId: 'gesture-save' });
        await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ kind: 'request',
            payload: expect.objectContaining({ kind: 'prepared', requestId: 'gesture-save' }) })));
        withdrawal.abort();
        expect(sent.filter(message => message.kind === 'disposeHostResource')).toHaveLength(1);
        await expect(control.update({ title: 'Withdrawn' })).rejects.toMatchObject({ code: 'aborted' });
        event({ kind: 'prepare', requestId: 'gesture-after-withdrawal' });
        expect(prepare).toHaveBeenCalledTimes(1);
        const execution = { ok: true, result: { saved: true } };
        settlePrepared(execution);
        await vi.waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(execution));
        event({ kind: 'settled', requestId: 'gesture-save', execution });
        settlePrepared(execution);
        expect(onSettled).toHaveBeenCalledTimes(1);
        await control.dispose();
    });

    it('forwards author Stop to the admitted request and settles its cancellation once', async () => {
        const { api, sent, event, settlePrepared } = await fixture(true, true);
        const onSettled = vi.fn();
        const stop = new AbortController();
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Save' } },
            { prepare: () => ({ input: {} }), onSettled }, { signal: stop.signal });
        event({ kind: 'prepare', requestId: 'gesture-save' });
        await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ kind: 'request',
            payload: expect.objectContaining({ kind: 'prepared' }) })));
        stop.abort();
        await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
        expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ ok: false, errorCode: 'aborted' });
        expect(sent.filter(message => message.kind === 'cancel')).toHaveLength(1);
        settlePrepared({ ok: false, errorCode: 'aborted', error: 'aborted' });
        await Promise.resolve();
        expect(onSettled).toHaveBeenCalledOnce();
        await control.dispose();
    });

    it('preserves an ordinary unavailable refusal when the person has not stopped the execution', async () => {
        const { api, sent, event, refusePrepared } = await fixture(true, true);
        const onSettled = vi.fn();
        const stop = new AbortController();
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Save' } },
            { prepare: () => ({ input: {} }), onSettled }, { signal: stop.signal });
        event({ kind: 'prepare', requestId: 'gesture-unavailable' });
        await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ kind: 'request',
            payload: expect.objectContaining({ kind: 'prepared' }) })));
        refusePrepared();
        await vi.waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: false, errorCode: 'unavailable', error: 'unavailable' }));
        await control.dispose();
    });

    it('settles once when the subscription and admitted request both return the execution', async () => {
        const { api, sent, event, settlePrepared } = await fixture(true, true);
        const onSettled = vi.fn();
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Save' } },
            { prepare: () => ({ input: {} }), onSettled });
        event({ kind: 'prepare', requestId: 'gesture-save' });
        await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ kind: 'request',
            payload: expect.objectContaining({ kind: 'prepared' }) })));
        const execution = { ok: true, result: { saved: true } };
        event({ kind: 'settled', requestId: 'gesture-save', execution });
        settlePrepared(execution);
        await Promise.resolve();
        expect(onSettled).toHaveBeenCalledExactlyOnceWith(execution);
        await control.dispose();
    });

    it('cancels thrown preparation and reports it to the original controller', async () => {
        const { api, sent, event } = await fixture();
        const onSettled = vi.fn();
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, {
            prepare() { throw new Error('Local validation failed'); }, onSettled,
        });
        event({ kind: 'prepare', requestId: 'gesture-failed' });
        await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith({ ok: false, errorCode: 'preparation_failed', error: 'Local validation failed' }));
        expect(sent).toContainEqual(expect.objectContaining({ kind: 'request', payload: {
            kind: 'prepared', subscriptionId: expect.any(String), requestId: 'gesture-failed', preparation: null,
        } }));
        await control.dispose();
    });

    it('retires preparation when a host event violates the closed control grammar', async () => {
        const { api, event } = await fixture();
        let signal: AbortSignal | undefined;
        const control = await api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, {
            prepare(options) { signal = options.signal; return new Promise(() => {}); }, onSettled() {},
        });
        event({ kind: 'prepare', requestId: 'gesture-valid' });
        expect(signal?.aborted).toBe(false);
        event({ kind: 'prepare', requestId: 'gesture-malformed', authority: 'present_user' });
        expect(signal?.aborted).toBe(true);
        await expect(control.update({ title: 'Retired' })).rejects.toMatchObject({ code: 'aborted' });
        await control.dispose();
    });

    it('refuses an unadvertised capability before binding', async () => {
        const { api, sent } = await fixture(false);
        await expect(api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, {
            prepare: () => null, onSettled() {},
        })).rejects.toMatchObject({ code: 'unsupported_method' });
        expect(sent.filter(message => message.kind === 'subscribe')).toEqual([]);
    });

    it('preserves canonical settlement custody and rejects authority fields at every control envelope', () => {
        const credentials = [{ v: 1, kind: 'connected_account', label: 'Workspace Account', owner: { kind: 'account', accountId: 'account' },
            service: { pluginId: 'acme.service', localId: 'service' }, why: { kind: 'purpose_binding',
                purpose: { consumer: { pluginId: 'acme.service', localId: 'consumer' }, purpose: 'compute' }, target: 'account' },
            currentness: { kind: 'current_at_materialization' } }];
        for (const execution of [
            { ok: true, result: { status: 'accepted', operationId: 'original-operation', completion: { status: 'pending' } }, operationCredentialUses: credentials },
            { ok: false, errorCode: 'action_outcome_unknown', error: 'Acceptance unknown', details: { operationId: 'original-operation' }, operationCredentialUses: credentials },
        ]) {
            const event = { kind: 'settled', requestId: 'original-gesture', execution };
            expect(PluginUiActionControlEventV1Schema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
            expect(PluginUiActionControlEventV1Schema.safeParse({ ...event, execution: { ...execution, personAuthority: true } }).success).toBe(false);
        }
        const bind = { kind: 'bind', subscriptionId: 'binding', action: 'projects.compute.exec', presentation: { title: 'Run' } };
        expect(PluginUiActionControlRequestV1Schema.safeParse({ ...bind, presentation: { title: '   ' } }).success).toBe(false);
        expect(PluginUiActionControlRequestV1Schema.safeParse({ ...bind, personAuthority: true }).success).toBe(false);
        expect(PluginUiActionControlRequestV1Schema.safeParse({ ...bind, presentation: { title: 'Run', execute: true } }).success).toBe(false);
        expect(PluginUiActionControlRequestV1Schema.safeParse({ kind: 'prepared', subscriptionId: 'binding', requestId: 'gesture',
            preparation: { input: {}, authority: 'present_user' } }).success).toBe(false);
    });
});

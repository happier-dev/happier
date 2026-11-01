import type { ConnectedAccountAuthenticationModeRuntime } from '../../connectedAccounts/authenticationTypes.js';
import type { ConnectedAccountEstablishedRuntime } from '../../connectedAccounts/establishedRuntimeTypes.js';
import { captureStaticRegistrationMethod, requireStaticRegistrationObject, type CapturedMethod } from './staticCapture.js';

type UnionKeys<T> = T extends unknown ? keyof T : never;
const authenticationCallbacks = {
    begin: true, complete: true, poll: true, cancel: true, reconcile: true,
} satisfies Record<Exclude<UnionKeys<ConnectedAccountAuthenticationModeRuntime<unknown>>, 'kind'>, true>;
const establishedCallbacks = {
    refresh: true, revoke: true, status: true, quota: true,
    materialize: true, enrichCredentialContext: true,
} satisfies Record<Exclude<keyof ConnectedAccountEstablishedRuntime<object>, 'recoveryCredits'>, true>;
const recoveryCallbacks = { read: true, consume: true } satisfies Record<
    keyof NonNullable<ConnectedAccountEstablishedRuntime<object>['recoveryCredits']>, true
>;

function captureCallbacks(receiver: object, callbacks: Readonly<Record<string, true>>) {
    const captured: Record<string, CapturedMethod> = {};
    for (const key of Object.keys(callbacks)) {
        const method = captureStaticRegistrationMethod<CapturedMethod>(receiver, key, `Connected Account runtime.${key}`, false);
        if (method) captured[key] = method;
    }
    return Object.freeze(captured);
}

/** Commit captures public callbacks once while preserving each author's receiver. */
export function snapshotConnectedAccountRuntime(value: unknown) {
    const receiver = requireStaticRegistrationObject(value, 'Connected Account runtime');
    const authentication = requireStaticRegistrationObject(Reflect.get(receiver, 'authentication'), 'Connected Account authentication');
    const modes = requireStaticRegistrationObject(Reflect.get(authentication, 'modes'), 'Connected Account authentication modes');
    const recovery = Reflect.get(receiver, 'recoveryCredits');
    return Object.freeze({
        ...captureCallbacks(receiver, establishedCallbacks),
        authentication: Object.freeze({
            modes: Object.freeze(Object.fromEntries(Object.entries(modes).map(([id, value]) => {
                const mode = requireStaticRegistrationObject(value, `Connected Account authentication mode '${id}'`);
                return [id, Object.freeze({ kind: Reflect.get(mode, 'kind'), ...captureCallbacks(mode, authenticationCallbacks) })];
            }))),
        }),
        ...(recovery === undefined ? {} : {
            recoveryCredits: captureCallbacks(requireStaticRegistrationObject(recovery, 'Connected Account recovery credits'), recoveryCallbacks),
        }),
    });
}

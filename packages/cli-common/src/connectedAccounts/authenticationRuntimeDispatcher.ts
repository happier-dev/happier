import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol';
import type { ConnectedAccountAttemptProviderOperation } from './authenticationAttemptOwner.js';
import type { ConnectedAccountAuthenticationModeRuntime } from './authenticationTypes.js';
import { snapshotConnectedAccountAuthenticationResult } from './producerResultSnapshot.js';

function unavailable(code: string) {
    return Object.freeze({ status: 'unavailable' as const,
        diagnostic: Object.freeze({ code, severity: 'error' as const }) });
}

/** Provider callback selection and result projection are the same on every host. */
export async function invokeConnectedAccountAuthenticationRuntime<Context>(input: Readonly<{
    mode: ConnectedAccountAuthenticationModeRuntime<Context> | undefined;
    descriptor: PluginConnectedAccountAuthenticationModeV2;
    operation: ConnectedAccountAttemptProviderOperation;
    context: Context;
    signal?: AbortSignal;
    registerRawForRedaction(value: string): void;
    invokeCallback<Result>(work: () => Result | Promise<Result>): Promise<Result>;
    redactDiagnosticText?(value: string): string;
}>): Promise<unknown> {
    const { mode, descriptor, operation, context, registerRawForRedaction, invokeCallback } = input;
    const result = await (async () => {
        if (!mode || mode.kind !== descriptor.kind) {
            return unavailable('connected_account_authentication_mode_unavailable');
        }
        const options = input.signal ? { signal: input.signal } : undefined;
        switch (operation.kind) {
            case 'beginOAuth':
                if (mode.kind !== 'oauthAuthorizationCode') break;
                registerRawForRedaction(operation.request.state);
                return invokeCallback(() => mode.begin(operation.request, context, options));
            case 'beginDevice':
                if (mode.kind !== 'oauthDeviceCode') break;
                return invokeCallback(() => mode.begin(context, options));
            case 'submitManual':
                if (mode.kind !== 'manual' || descriptor.kind !== 'manual') break;
                for (const field of descriptor.fields) {
                    if (!field.secret) continue;
                    const value = operation.fields[field.id];
                    if (value !== undefined) registerRawForRedaction(value);
                }
                return invokeCallback(() => mode.complete(Object.freeze({ fields: operation.fields }), context, options));
            case 'completeOAuth':
                if (mode.kind !== 'oauthAuthorizationCode') break;
                registerRawForRedaction(operation.completion.code);
                registerRawForRedaction(operation.completion.callbackUrl);
                registerRawForRedaction(operation.completion.state);
                registerRawForRedaction(operation.completion.pkceVerifier);
                return invokeCallback(() => mode.complete(operation.completion, context, options));
            case 'pollDevice':
                if (mode.kind !== 'oauthDeviceCode') break;
                return invokeCallback(() => mode.poll(context, options));
            case 'reconcile':
                if (typeof mode.reconcile !== 'function') break;
                return invokeCallback(() => mode.reconcile!(context, options));
            case 'cancel':
                return invokeCallback(() => mode.kind === 'manual' ? undefined : mode.cancel(context));
        }
        return unavailable('connected_account_authentication_operation_unavailable');
    })();
    return snapshotConnectedAccountAuthenticationResult(result, input.redactDiagnosticText);
}

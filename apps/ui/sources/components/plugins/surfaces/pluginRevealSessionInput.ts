import { router } from 'expo-router';
import { PluginUiRevealSessionInputRequestV1Schema, type PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { readSessionMessageReplyInput } from '@/sync/api/session/sessionMessageReplyApi';
import { getActiveServerAccountScope, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler, type PluginSurfaceHostApiRequestOptions } from './createPluginSurfaceHostApi';

/** An exact input adapter to the existing scoped transcript route, never another scroll owner. */
export function createPluginRevealSessionInputHandler(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
    lifetimeSignal?: AbortSignal;
}>) {
    return async (payload: unknown, options?: PluginSurfaceHostApiRequestOptions): Promise<PluginUiJsonValueV1> => {
        const parsed = PluginUiRevealSessionInputRequestV1Schema.safeParse(payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['session_input_reveal_invalid']);
        const refusal = () => {
            if (!input.isCurrent() || !input.accountLifetime.isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
            if (input.lifetimeSignal?.aborted || options?.signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['session_input_reveal_aborted']);
            if (!areServerAccountScopesEqual(input.accountLifetime.scope, getActiveServerAccountScope())) {
                return createPluginSurfaceHostApiError('unavailable', ['session_input_reveal_active_account_required']);
            }
            return null;
        };
        const refused = refusal();
        if (refused) return refused;
        const cancellation = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        try {
            const message = await readSessionMessageReplyInput({ scope: input.accountLifetime.scope, ...parsed.data,
                signal: cancellation.signal, isCurrent: () => refusal() === null });
            const retired = refusal();
            if (retired) return retired;
            if (!message || message.messageRole !== 'user' || message.sidechainId != null) {
                return createPluginSurfaceHostApiError('unavailable', ['session_input_reveal_unavailable']);
            }
            // This route renders non-tool rows in SessionDestinationBody and passes
            // the exact committed message to the canonical transcript jump owner.
            try {
                router.push(buildScopedSessionRouteHref({ sessionId: parsed.data.sessionId,
                    serverId: input.accountLifetime.scope.serverId, messageId: message.id }));
            } catch {
                return createPluginSurfaceHostApiError('unavailable', ['session_input_reveal_navigation_unavailable']);
            }
            return null;
        } finally { cancellation.dispose(); }
    };
}

export function createPluginRevealSessionInputHostApiHandler(input: Parameters<typeof createPluginRevealSessionInputHandler>[0]): PluginSurfaceHostApiMethodHandler {
    const reveal = createPluginRevealSessionInputHandler(input);
    return (request, options) => request.method === 'revealSessionInput' ? reveal(request.payload, options)
        : createPluginSurfaceHostApiError('unsupported_method');
}

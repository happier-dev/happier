import type { ConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { RequesterSessionRuntimeContext } from '../../sessionEncryption/requesterSessionCredentials';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
    ConnectedAccountRequestAuthError,
    type ConnectedAccountRequestAuthServiceDependencies,
} from './ConnectedAccountRequestAuthService';

/** The daemon's existing qualified purpose callbacks; legacy ingress stays at its caller. */
type RequestAuthAccountContext = Readonly<{
    bootstrap: Pick<RequesterSessionRuntimeContext['bootstrap'], 'serverHttpBaseUrl'>;
}> & Pick<RequesterSessionRuntimeContext, 'isCurrent' | 'resolveCurrentRequestAuthBinding' | 'materializeRequestAuthBearer'>;

export function createDaemonQualifiedRequestAuthCallbacks<T extends RequestAuthAccountContext>(params: Readonly<{
    resolveCurrentRequestAuthBinding?: ConnectedAccountPurposeBindingOwner['resolveCurrentRequestAuthBinding'];
    materializeRequestAuthBearer?: ConnectedAccountPurposeBindingOwner['materializeRequestAuthBearer'];
    resolveSessionAccountContext?: (sessionId: string) => Promise<T | null>;
    assertSessionAccountCurrent?: (sessionId: string, expected: T | null) => Promise<void>;
}>): Pick<ConnectedAccountRequestAuthServiceDependencies, 'resolveCurrentBinding' | 'materializeBearer'> {
    return {
        resolveCurrentBinding: async ({ subject, binding, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) return null;
            try {
                const context = subject.parentSessionId ? await params.resolveSessionAccountContext?.(subject.parentSessionId) ?? null : null;
                const resolve = context ? context.resolveCurrentRequestAuthBinding : params.resolveCurrentRequestAuthBinding;
                if (!resolve) return null;
                if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                if (context && !await context.isCurrent()) throw new Error('requester_session_not_current');
                const read = () => resolve({ subjectId: subject.subjectId, binding, signal });
                const resolved = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, read) : read());
                signal.throwIfAborted();
                if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                if (context && !await context.isCurrent()) throw new Error('requester_session_not_current');
                if (!subject.isCurrent() || !resolved) return null;
                return Object.freeze({ account: resolved.account, credentialRevision: resolved.credentialRevision,
                    ...(resolved.group ? { group: resolved.group } : {}) });
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof ConnectedAccountRequestAuthError) throw error;
                throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable');
            }
        },
        materializeBearer: async ({ subject, binding, resolved, materialization, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
            const context = subject.parentSessionId ? await params.resolveSessionAccountContext?.(subject.parentSessionId) ?? null : null;
            const materialize = context ? context.materializeRequestAuthBearer : params.materializeRequestAuthBearer;
            if (!materialize) throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable');
            if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
            if (context && !await context.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
            const read = () => materialize({ subjectId: subject.subjectId, binding, resolved, materialization, signal });
            const result = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, read) : read());
            signal.throwIfAborted();
            if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
            if (context && !await context.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
            if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
            return result;
        },
    };
}

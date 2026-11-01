import { createHomeDomainActionExecutorForScope } from '@/sync/api/home/homeDomainActions';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

/**
 * One Action front door for one exact Home and Account.
 *
 * Home-governance, Team, identity-provider, and managed GitHub clients all use
 * this owner. Their HTTP leaves know only how to carry a declared Action row;
 * admission, settings, approval, provenance, and output validation therefore
 * cannot be bypassed by one administration surface growing its own adapter.
 */
const executorsByScope = new Map<
    string,
    ReturnType<typeof createFrontDoorActionExecute>
>();

export function scopedHomeActionExecutor(
    scope: ServerAccountScope,
    options?: Pick<NonNullable<Parameters<typeof createDefaultActionExecutor>[0]>, 'teamMembershipHistoryAction' | 'onBlockingApprovalPending' | 'hostActionApprovalLifetime'> & Readonly<{
        /** Invocation-local currentness, checked after admission before a snapshot read dispatches. */
        homeDomainReadCurrentness?: () => boolean;
    }>,
): ReturnType<typeof createFrontDoorActionExecute> {
    const key = serverAccountScopeKeySuffix(scope);
    const existing = executorsByScope.get(key);
    if (existing && !options) return existing;

    const { homeDomainReadCurrentness, ...ordinaryOptions } = options ?? {};
    const executorOptions = {
        homeDomainAction: createHomeDomainActionExecutorForScope(scope, undefined, homeDomainReadCurrentness),
        ...ordinaryOptions,
    };
    const ordinary = createFrontDoorActionExecute(createDefaultActionExecutor(executorOptions));
    const forInvocation = (actionId: Parameters<typeof ordinary>[0], context: Parameters<typeof ordinary>[2]) => {
        // Only host-owned page controls lend their ephemeral page-follow values
        // and mount signal. Settings Ask must retain that exact invocation,
        // including when a native surface supplies this shared scoped executor.
        if (context?.surface === 'ui' && context.authority === 'present_user'
            && context.actionCaller?.kind === 'host' && context.widgetAreaContext && context.signal) {
            return createFrontDoorActionExecute(createDefaultActionExecutor({ ...executorOptions,
                hostActionApprovalLifetime: { actionId, signal: context.signal, surface: 'ui' },
            }));
        }
        return ordinary;
    };
    const execute: typeof ordinary = Object.assign((...args: Parameters<typeof ordinary>) =>
        forInvocation(args[0], args[2])(...args), {
        confirmed: (...args: Parameters<typeof ordinary>) => forInvocation(args[0], args[2]).confirmed(...args),
        prepare: ordinary.prepare,
    });
    if (!options) executorsByScope.set(key, execute);
    return execute;
}

export function resetScopedHomeActionExecutorsForTests(): void {
    executorsByScope.clear();
}

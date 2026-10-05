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
): ReturnType<typeof createFrontDoorActionExecute> {
    const key = serverAccountScopeKeySuffix(scope);
    const existing = executorsByScope.get(key);
    if (existing) return existing;

    const execute = createFrontDoorActionExecute(createDefaultActionExecutor({
        homeDomainAction: createHomeDomainActionExecutorForScope(scope),
    }));
    executorsByScope.set(key, execute);
    return execute;
}

export function resetScopedHomeActionExecutorsForTests(): void {
    executorsByScope.clear();
}

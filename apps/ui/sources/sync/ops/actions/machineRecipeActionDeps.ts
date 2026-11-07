import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** Read the reviewed target's cold recipe family through the canonical projection transport. */
export function createUiMachineRecipesRead(account: LazyActionAccountContext | undefined): NonNullable<ActionExecutorDeps['machineRecipesRead']> {
    return (args, context) => withActionAccountRequestSignal(account, context.signal, async callerSignal => {
        const unavailable = { ok: false as const, errorCode: 'unavailable', error: 'unavailable' };
        let targetAccount: LazyActionAccountContext | undefined;
        try {
            targetAccount = account && areServerProfileIdentifiersEquivalent(account.serverId, args.homeId)
                ? account : await captureLazyActionAccountContext(args.homeId, callerSignal);
            const target = targetAccount;
            return await withActionAccountRequestSignal(target, callerSignal, async signal => {
                target.assertCurrent();
                const response = await machineContributionRegistryProjectionDescribe(args.machineId, {
                    serverId: args.homeId, selection: 'machineRecipes', signal, accountLifetime: target.accountLifetime,
                    ...(args.recipeRefs === undefined ? {} : { recipeRefs: args.recipeRefs }),
                });
                signal?.throwIfAborted();
                target.assertCurrent();
                const family = response.supported ? response.projection.familiesById.machineRecipes : undefined;
                return family?.family === 'machineRecipes' && response.supported
                    ? { entries: Object.values(family.entriesById),
                        ...(response.machineRecipeTarget === undefined ? {} : { target: response.machineRecipeTarget }) }
                    : unavailable;
            });
        } catch {
            callerSignal?.throwIfAborted();
            return unavailable;
        } finally {
            if (targetAccount && targetAccount !== account) targetAccount.dispose();
        }
    });
}

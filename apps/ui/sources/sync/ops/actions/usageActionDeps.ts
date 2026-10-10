import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';
import { readUiUsageModelPrices, readUiUsageQueryBatch, type UsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import type { LazyActionAccountContext } from './actionAccountContext';
import { HappyError } from '@/utils/errors/errors';

/** Captured Home/Account reads use the same query adapter as mounted Resources. */
export function createUiUsageActionPorts(account: UsageQueryAccountContext & Pick<LazyActionAccountContext, 'assertCurrent'>,
  renderRecap?: UsageActionPorts['renderRecap']): UsageActionPorts {
  const prices = async (refresh: boolean, context: Parameters<NonNullable<UsageActionPorts['prices']>['get']>[0]) => {
    context.signal?.throwIfAborted();
    account.assertCurrent();
    try {
      const value = await readUiUsageModelPrices(account, refresh, context.signal);
      context.signal?.throwIfAborted();
      account.assertCurrent();
      return value;
    } catch (error) {
      account.assertCurrent();
      context.signal?.throwIfAborted();
      if (error instanceof HappyError && error.code) return { ok: false as const, errorCode: error.code, error: error.code };
      throw error;
    }
  };
  return {
    prices: { get: context => prices(false, context), refresh: context => prices(true, context) },
    query: async (input, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      let result: Awaited<ReturnType<typeof readUiUsageQueryBatch>>;
      try {
        result = await readUiUsageQueryBatch(account, input, context.signal);
      } catch (error) {
        account.assertCurrent();
        context.signal?.throwIfAborted();
        if (error instanceof HappyError && error.code === 'denied') return { ok: false, errorCode: 'denied', error: 'denied' };
        throw error;
      }
      account.assertCurrent();
      context.signal?.throwIfAborted();
      return result;
    },
    renderRecap: async (compose, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      const retired = new AbortController();
      const removeRetire = account.accountLifetime.onRetire(() => retired.abort());
      const abort = () => retired.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      try {
        const render = renderRecap ?? (await import('@/components/settings/usage/widgets/recap/renderUsageRecapImage')).renderUsageRecapImage;
        account.assertCurrent();
        const result = await render(compose, { ...context, signal: retired.signal });
        context.signal?.throwIfAborted();
        account.assertCurrent();
        return result;
      } finally {
        removeRetire.dispose();
        context.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

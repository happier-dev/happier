import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { decodeUsageQueryResource, getUsageQueryResourceStore, readUiQuota, readUiUsageModelPrices, type UsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import type { LazyActionAccountContext } from './actionAccountContext';
import { HappyError } from '@/utils/errors/errors';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

type PublicProfileRead = Awaited<ReturnType<NonNullable<UsageActionPorts['readPublicProfile']>>>;
const publicProfileReads = createScopedResolutionSingleFlight<PublicProfileRead>();

async function consumePublicProfile(response: Response): Promise<PublicProfileRead> {
  if ([404, 405, 501].includes(response.status)) return { kind: 'unavailable' };
  if (!response.ok) return { ok: false, errorCode: response.status === 401 || response.status === 403 ? 'denied' : 'public_profile_read_failed',
    error: 'public_profile_read_failed' };
  const result = PublicProfileReadResultV1Schema.safeParse(await response.json());
  return result.success ? result.data : { ok: false, errorCode: 'public_profile_result_invalid', error: 'public_profile_result_invalid' };
}

/** Captured Home/Account reads use the same query adapter as mounted Resources. */
export function createUiUsageActionPorts(account: UsageQueryAccountContext & Pick<LazyActionAccountContext, 'assertCurrent'>,
  renderRecap?: UsageActionPorts['renderRecap']): UsageActionPorts {
  const prices = async (refresh: boolean, context: Parameters<NonNullable<UsageActionPorts['prices']>['get']>[0]) => {
    throwIfAborted(context.signal);
    account.assertCurrent();
    try {
      const value = await readUiUsageModelPrices(account, refresh, context.signal);
      throwIfAborted(context.signal);
      account.assertCurrent();
      return value;
    } catch (error) {
      account.assertCurrent();
      throwIfAborted(context.signal);
      if (error instanceof HappyError && error.code) return { ok: false as const, errorCode: error.code, error: error.code };
      throw error;
    }
  };
  return {
    readPublicProfile: async context => {
      throwIfAborted(context.signal);
      account.assertCurrent();
      const path = '/v1/account/public-profile/view';
      const init = { method: 'GET', headers: { Authorization: `Bearer ${account.credentials.token}` } };
      const transport = account.readTransport;
      if (!transport) {
        const result = await consumePublicProfile(await account.request(path, { ...init, signal: context.signal }));
        throwIfAborted(context.signal);
        account.assertCurrent();
        return result;
      }
      const bindingKey = transport.key;
      const retirement = new AbortController();
      const release = account.accountLifetime.onRetire(() => retirement.abort());
      const cancellation = mergeAbortSignals([context.signal, retirement.signal]);
      try {
        const result = await publicProfileReads.run(JSON.stringify([bindingKey, path]),
          signal => transport.read(path, { ...init, signal }, undefined, consumePublicProfile),
          { scope: transport.scope ?? bindingKey, signal: cancellation.signal });
        throwIfAborted(context.signal);
        account.assertCurrent();
        return result;
      } catch (error) {
        // Scope retirement is an Account refusal, not the caller cancelling its intent.
        account.assertCurrent();
        throwIfAborted(context.signal);
        throw error;
      } finally { cancellation.dispose(); release.dispose(); }
    },
    prices: { get: context => prices(false, context), refresh: context => prices(true, context) },
    readQuota: async (input, context) => {
      throwIfAborted(context.signal);
      account.assertCurrent();
      try {
        // Calendar selections require their exact retained B, not the query's
        // accounting-ready snapshot while independent quota reads progress.
        const value = await readUiQuota(account, input, context.signal);
        throwIfAborted(context.signal);
        account.assertCurrent();
        return value;
      } catch (error) {
        account.assertCurrent();
        throwIfAborted(context.signal);
        if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code) {
          return { ok: false, errorCode: error.code, error: error.code };
        }
        throw error;
      }
    },
    query: async (input, context) => {
      throwIfAborted(context.signal);
      account.assertCurrent();
      let release: (() => void) | undefined;
      let abort: (() => void) | undefined;
      try {
        // A one-shot Action returns its current truthful snapshot; it does not
        // harvest every optional source. This exact Resource also belongs to
        // mounted consumers, whose subscriptions own subsequent progression.
        const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
        const result = await new Promise<UsageQueryBatchResult>((resolve, reject) => {
          const inspect = () => {
            try {
              account.assertCurrent();
              throwIfAborted(context.signal);
              const snapshot = entry.getSnapshot();
              if (snapshot.error) throw new HappyError(snapshot.error.message, false, { code: snapshot.error.code });
              if (!snapshot.value || snapshot.freshness !== 'fresh') return;
              const batch = decodeUsageQueryResource(snapshot.value);
              // Coach must inspect the requested private evidence, rather than
              // refuse advice from the earlier accounting-only revision.
              if (context.usageQueryReadiness === 'coach_evidence' && batch.results.some(slice =>
                slice.requestedQuery.includeSessionEvidence && slice.sources.some(source =>
                  source.source === 'how_you_work' && ['pending', 'not_loaded'].includes(source.status)))) return;
              if (context.usageQueryReadiness === 'public_profile' && batch.results.some(slice => slice.sources.some(source =>
                (source.source === 'how_you_work' && slice.requestedQuery.includeSessionEvidence
                  || source.source === 'work' && slice.requestedQuery.includeWorkEvidence)
                && ['pending', 'not_loaded'].includes(source.status)))) return;
              if (batch.results.every(slice => slice.sources.some(source => source.source === 'accounting'
                && !['pending', 'not_loaded'].includes(source.status)))) resolve(batch);
            } catch (error) { reject(error); }
          };
          // An initial read also supplies the Resource owner's terminal
          // admission result. The static subscription joins this same read.
          const baseline = entry.getSnapshot().value ? undefined : entry.refresh();
          release = entry.subscribe(inspect, false);
          void baseline?.then(snapshot => {
            if (snapshot.error) reject(new HappyError(snapshot.error.message, false, { code: snapshot.error.code }));
            else inspect();
          }, reject);
          abort = inspect;
          context.signal?.addEventListener('abort', abort, { once: true });
          inspect();
        });
        account.assertCurrent();
        throwIfAborted(context.signal);
        return result;
      } catch (error) {
        account.assertCurrent();
        throwIfAborted(context.signal);
        if (error instanceof HappyError && error.code) return { ok: false, errorCode: error.code, error: error.code };
        throw error;
      } finally {
        release?.();
        if (abort) context.signal?.removeEventListener('abort', abort);
      }
    },
    renderRecap: async (compose, context) => {
      throwIfAborted(context.signal);
      account.assertCurrent();
      const retired = new AbortController();
      const removeRetire = account.accountLifetime.onRetire(() => retired.abort());
      const abort = () => retired.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      try {
        const render = renderRecap ?? (await import('@/components/settings/usage/widgets/recap/renderUsageRecapImage')).renderUsageRecapImage;
        account.assertCurrent();
        const result = await render(compose, { ...context, signal: retired.signal });
        throwIfAborted(context.signal);
        account.assertCurrent();
        return result;
      } finally {
        removeRetire.dispose();
        context.signal?.removeEventListener('abort', abort);
      }
    },
    deliverRecap: async (file, intent, context) => {
      throwIfAborted(context.signal);
      account.assertCurrent();
      const retired = new AbortController();
      const removeRetire = account.accountLifetime.onRetire(() => retired.abort());
      const abort = () => retired.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      try {
        const { deliverUsageImageFileResult } = await import('@/components/settings/usage/usageImageFile');
        account.assertCurrent();
        const result = await deliverUsageImageFileResult(file, intent, { signal: retired.signal,
          isCurrent: () => { account.assertCurrent(); return true; } });
        throwIfAborted(context.signal);
        account.assertCurrent();
        return result;
      } finally {
        removeRetire.dispose();
        context.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

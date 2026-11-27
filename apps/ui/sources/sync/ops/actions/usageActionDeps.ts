import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { decodeUsageQueryResource, getUsageQueryResourceStore, readUiQuota, readUiUsageModelPrices, getUiUsageHistoryState, readUiUsageHistory, cancelUiUsageHistory, type UsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import type { LazyActionAccountContext } from './actionAccountContext';
import { HappyError } from '@/utils/errors/errors';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createUiCoachSuppressionPort } from '@/sync/api/account/usageCoachSuppressions';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';

type PublicProfileRead = Awaited<ReturnType<NonNullable<UsageActionPorts['readPublicProfile']>>>;
const publicProfileReads = createScopedResolutionSingleFlight<PublicProfileRead>();

async function consumePublicProfile(response: Response): Promise<PublicProfileRead> {
  if ([404, 405, 501].includes(response.status)) return { kind: 'unavailable' };
  if (!response.ok) {
    if (response.status === 403) {
      const refusal = readActionCredentialScopeDeniedHttpFailureV1(response.status, await response.json().catch(() => null));
      if (refusal) return refusal;
    }
    return { ok: false, errorCode: response.status === 401 || response.status === 403 ? 'denied' : 'public_profile_read_failed',
      error: 'public_profile_read_failed' };
  }
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
      const failure = parseActionExecuteFailure(error);
      if (failure) return failure;
      if (error instanceof HappyError && error.code) return { ok: false as const, errorCode: error.code, error: error.code };
      throw error;
    }
  };
  return {
    coachSuppressions: context => createUiCoachSuppressionPort(account, context.signal),
    history: async (input, context) => {
      throwIfAborted(context.signal);
      account.assertCurrent();
      try {
        if (input.operation === 'status') return getUiUsageHistoryState(account, input.query);
        if (input.operation === 'cancel') {
          cancelUiUsageHistory(account, input.query);
          return getUiUsageHistoryState(account, input.query);
        }
        const release = context.operationCancellation?.onRequest(() => cancelUiUsageHistory(account, input.query));
        try {
          const result = await readUiUsageHistory(account, { query: input.query }, { signal: context.signal,
            onProgress: state => {
              const progress = { phase: state.status, current: state.progress.completed };
              context.operationProgress?.update(progress);
              context.operationOwnerUpdate?.update({ ...(state.status === 'reading'
                ? { state: 'running' as const, cancellation: 'supported' as const } : {}), progress });
            } });
          account.assertCurrent();
          return result;
        } finally { release?.(); }
      } catch (error) {
        account.assertCurrent();
        if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code) {
          return { ok: false, errorCode: error.code, error: error.code };
        }
        throw error;
      }
    },
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
        const value = await readUiQuota({ ...account, callerContext: context }, input, context.signal);
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
      try {
        const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
        const joined = entry.acquire(context);
        const needsEvidence = joined.workAwaitingOwnRead || joined.needsCoachEvidence
          || context.usageQueryReadiness === 'public_profile';
        const result = await new Promise<UsageQueryBatchResult>((resolve, reject) => {
          let accounting: UsageQueryBatchResult | undefined;
          const requireJoinedRead = () => {
            account.assertCurrent();
            throwIfAborted(context.signal);
            if (joined.signal?.aborted) throw new HappyError('Usage Resource read was cancelled', false, { code: 'plugin_resource_aborted' });
          };
          const inspect = () => {
            try {
              requireJoinedRead();
              if (!accounting) return;
              if (!needsEvidence) {
                resolve(accounting);
                return;
              }
              const content = joined.getEvidenceContent();
              if (!content) return;
              const batch = decodeUsageQueryResource(content);
              if (context.usageQueryReadiness === 'public_profile' && batch.results.some(slice => slice.sources.some(source =>
                (source.source === 'how_you_work' && slice.requestedQuery.includeSessionEvidence
                  || source.source === 'work' && slice.requestedQuery.includeWorkEvidence)
                && ['pending', 'not_loaded'].includes(source.status)))) return;
              resolve(batch);
            } catch (error) { reject(error); }
          };
          const cancellation = mergeAbortSignals([context.signal, joined.signal]);
          release = entry.subscribe(inspect, false);
          cancellation.signal?.addEventListener('abort', inspect, { once: true });
          const unsubscribe = release;
          release = () => {
            cancellation.signal?.removeEventListener('abort', inspect);
            cancellation.dispose();
            unsubscribe();
          };
          void joined.accounting.then(outcome => {
            if (!outcome.ok) { reject(outcome.error); return; }
            accounting = decodeUsageQueryResource(outcome.value);
            inspect();
          }, reject);
          if (needsEvidence) {
            void joined.evidenceCompletion?.then(content => {
              try {
                requireJoinedRead();
                resolve(decodeUsageQueryResource(content));
              } catch (error) { reject(error); }
            }, reject);
          }
          inspect();
        });
        account.assertCurrent();
        throwIfAborted(context.signal);
        return result;
      } catch (error) {
        account.assertCurrent();
        throwIfAborted(context.signal);
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code) {
          const details = error instanceof HappyError || isPluginError(error) ? error.details : undefined;
          return { ok: false, errorCode: error.code, error: error.code,
            ...(error.code === 'usage_query_result_invalid' && details !== undefined ? { details } : {}) };
        }
        throw error;
      } finally {
        release?.();
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
        const renderer = renderRecap ? null : await import('@/components/settings/usage/widgets/recap/renderUsageRecapImage');
        account.assertCurrent();
        const result = renderRecap
          ? await renderRecap(compose, { ...context, signal: retired.signal })
          : await renderer!.renderUsageRecapImage(compose, { ...context, signal: retired.signal },
            readCurrentUiContextActionReader(context)?.commandBridge);
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
        // The adapter checked cancellation/Account authority before the effect.
        // Its settled outcome is not revoked when the requesting view departs.
        return result;
      } finally {
        removeRetire.dispose();
        context.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

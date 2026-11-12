import type {
  ManagedProviderExplicitStartCustody,
  ManagedProviderExplicitStartCustodyRequest,
} from '@/providers/connections/publicManagedRuntimeStart';
import type { SharedManagedProviderGatewayBinding } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

type AcquiredBrokerSourceOperation = Readonly<{
  projection: NonNullable<Awaited<ReturnType<ManagedProviderExplicitStartCustody['acquire']>>>;
  /** The last decided answer, without re-reading anything. */
  isAuthorizationCurrent(): boolean;
  /** End the operation's custody claim. Idempotent and never double-retires. */
  retire(): Promise<void>;
}>;

/**
 * Admit one broker source into managed Provider custody. The source decision
 * belongs to this opening; retained requests consume that decision while
 * custody owns physical endpoint liveness and explicit retirement.
 * A cancelled caller cannot withdraw another caller's operation claim.
 */
export async function acquireBrokerSourceOperation(input: Readonly<{
  sharedGateway?: SharedManagedProviderGatewayBinding;
  retirementGroup?: ManagedProviderExplicitStartCustodyRequest['retirementGroup'];
  custody: ManagedProviderExplicitStartCustody;
  identity: ManagedProviderExplicitStartCustodyRequest['identity'];
  contributionKey: string;
  endpointTemplateId: string;
  operationClaim: ManagedProviderExplicitStartCustodyRequest['operationClaim'];
  purposeBindings: ManagedProviderExplicitStartCustodyRequest['purposeBindings'];
  modelCatalogs?: ManagedProviderExplicitStartCustodyRequest['modelCatalogs'];
  /** Source authority at this opening's admission boundary. */
  isSourceCurrent(signal: AbortSignal): Promise<boolean>;
  callerSignal: AbortSignal;
}>): Promise<AcquiredBrokerSourceOperation | Readonly<{ unavailable: 'source_currentness_unknown' }> | null> {
  let authorizationCurrent = true;
  // Asserted so TypeScript does not narrow this closure-written local to 'current'.
  let lastSourceRead = 'current' as 'current' | 'stale' | 'unknown';
  const isAuthorizationCurrent = (): boolean => authorizationCurrent && !retired && !retireInFlight;
  // One source decision belongs to this admitted opening. Later requests and
  // physical re-joins consume it without consulting a newer Home projection.
  let admissionRead: Promise<boolean> | null = null;
  const revalidateAuthorization = async (
    signal: AbortSignal = input.callerSignal,
  ): Promise<boolean> => {
    if (signal.aborted || !authorizationCurrent) return false;
    admissionRead ??= (async () => {
      try {
        const current = await input.isSourceCurrent(signal);
        if (signal.aborted) return false;
        lastSourceRead = current ? 'current' : 'stale';
        authorizationCurrent = current;
        return current;
      } catch {
        if (!signal.aborted) lastSourceRead = 'unknown';
        return false;
      }
    })();
    return !signal.aborted && await admissionRead;
  };
  let retired = false;
  let refreshInFlight: Promise<boolean> | null = null;
  let retireInFlight: Promise<void> | null = null;
  const retire = (): Promise<void> => {
    if (retired) return Promise.resolve();
    retireInFlight ??= (async () => {
      await refreshInFlight;
      await input.custody.retire({
        identity: input.identity,
        operationClaim: input.operationClaim,
        ...(input.sharedGateway ? { sharedGateway: input.sharedGateway } : {}),
      });
    })().then(
      () => {
        retired = true;
        retireInFlight = null;
      },
      (error: unknown) => {
        retireInFlight = null;
        throw error;
      },
    );
    return retireInFlight;
  };
  const acquireProjection = (signal: AbortSignal) => input.custody.acquire({
    ...(input.sharedGateway ? { sharedGateway: input.sharedGateway } : {}),
    ...(input.retirementGroup ? { retirementGroup: input.retirementGroup } : {}),
    contributionKey: input.contributionKey,
    identity: input.identity,
    request: {
      reason: 'explicitStartLocal',
      endpointTemplateIds: [input.endpointTemplateId],
    },
    purposeBindings: input.purposeBindings,
    ...(input.modelCatalogs ? { modelCatalogs: input.modelCatalogs } : {}),
    isAuthorizationCurrent,
    revalidateAuthorization,
    operationClaim: input.operationClaim,
    signal,
  });
  let acquired: Awaited<ReturnType<typeof acquireProjection>>;
  try {
    acquired = await acquireProjection(input.callerSignal);
  } catch (error) {
    if (lastSourceRead === 'unknown') return { unavailable: 'source_currentness_unknown' };
    throw error;
  }
  if (!acquired || input.callerSignal.aborted || !await revalidateAuthorization()) {
    if (acquired) {
      if (!input.callerSignal.aborted && lastSourceRead !== 'unknown') {
        await retire().catch(() => undefined);
      }
      await Promise.resolve(acquired.cleanup()).catch(() => undefined);
    }
    return lastSourceRead === 'unknown' ? { unavailable: 'source_currentness_unknown' } : null;
  }
  if (!input.sharedGateway) return Object.freeze({ projection: acquired, isAuthorizationCurrent, retire });
  let projection = acquired;
  // A surviving consumer retains its admitted source, not a dead physical endpoint.
  // Rejoin the exact existing explicit-Start claim before dispatch, never
  // after a request has reached the upstream transport.
  const ensureProjection = async (signal: AbortSignal = input.callerSignal): Promise<boolean> => {
    if (retired || retireInFlight || !await revalidateAuthorization(signal)) return false;
    if (projection.isCurrent()) return true;
    refreshInFlight ??= (async () => {
      // Keep this source opening's lifetime, not one forwarded HTTP request's
      // cancellation. Local consumers retain an opening; the carrier opens a
      // fresh source for each admitted stream against the same custody claim.
      const replacement = await acquireProjection(input.callerSignal);
      if (!replacement) return false;
      const previous = projection;
      projection = replacement;
      await previous.cleanup();
      return !retired && !retireInFlight && replacement.isCurrent();
    })().finally(() => { refreshInFlight = null; });
    return await refreshInFlight;
  };
  const retainedProjection = Object.freeze({
    access: Object.freeze({
      endpointUrl: (endpointTemplateId: string) => projection.access.endpointUrl(endpointTemplateId),
      async request(request: Parameters<typeof projection.access.request>[0]) {
        if (retired || retireInFlight || !isAuthorizationCurrent()
          || !projection.isCurrent() && !await ensureProjection(request.signal)) {
          throw createProviderErrorV1('provider_endpoint_unavailable', { connectionId: input.sharedGateway?.connectionId });
        }
        return await projection.access.request(request);
      },
    }),
    isCurrent: () => !retired && !retireInFlight && projection.isCurrent(),
    cleanup: async () => await projection.cleanup(),
  });
  return Object.freeze({ projection: retainedProjection, isAuthorizationCurrent, retire });
}

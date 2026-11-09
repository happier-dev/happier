import { canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { ProviderLocalInstallationSummaryV1Schema } from '@happier-dev/protocol/providers/detection/v1';
import type { ProviderLocalInstallationSummaryV1 } from '@happier-dev/protocol';

import type { ProviderContributionRegistryView } from '@/providers/registry';
import { awaitWithinProviderOperation, createProviderOperationLifetime, ProviderOperationAbandonedError, type ProviderOperationLifetime } from '@/providers/operationLifetime';
import {
  resolveDeclaredProviderInstallation,
  runDeclaredProviderLocalCommand,
  type ProviderLocalCommandRunner,
  type ProviderLocalToolResolver,
} from '@/providers/probe/localCommand';

export type ProviderLocalInstallationReadResult = Readonly<{
  status: 'complete' | 'incomplete';
  installations: readonly ProviderLocalInstallationSummaryV1[];
}>;

export function createProviderLocalInstallationReader(input: ProviderLocalToolResolver & ProviderLocalCommandRunner) {
  const inFlight = new Map<string, Promise<boolean>>();

  const inspectPresence = async (params: Readonly<{
    machineId: string;
    contributionKey: string;
    providerName: string;
    presenceCheck?: Readonly<{
      lookupNames: readonly string[];
      fixedArgs: readonly string[];
      parser: 'exit-zero-running' | 'lms-status-json';
    }>;
    managedStartAvailable: boolean;
    lifetime: ProviderOperationLifetime;
  }>): Promise<ProviderLocalInstallationSummaryV1> => {
    const presence = params.presenceCheck
      ? await runDeclaredProviderLocalCommand({
          toolId: `provider-presence:${params.contributionKey}`,
          lookupNames: params.presenceCheck.lookupNames,
          fixedArgs: params.presenceCheck.fixedArgs,
          parser: params.presenceCheck.parser,
        }, input, params.lifetime)
      : { status: 'absent' as const };
    return ProviderLocalInstallationSummaryV1Schema.parse({
      v: 1,
      machineId: params.machineId,
      contributionKey: params.contributionKey,
      providerName: params.providerName,
      status: presence.status === 'present' ? 'app_running_server_off' : 'installed_not_running',
      managedStartAvailable: params.managedStartAvailable,
    });
  };

  const readInstalled = async (params: Readonly<{
    machineId: string;
    contributionKey: string;
    installedCheck: Readonly<{ lookupNames: readonly string[] }>;
    signal?: AbortSignal;
  }>): Promise<boolean> => {
    const serializedKey = JSON.stringify([params.machineId,
      canonicalizeProviderContributionKeyV1(params.contributionKey), params.installedCheck.lookupNames]);
    if (params.signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');

    // The declared installation lookup reaches an OS filesystem/PATH boundary
    // with no abort handle, so waiter cancellation never stops it. Custody of the
    // single-flight key therefore follows the underlying operation, not the
    // waiter: another read must join the same lookup rather than
    // start a second one that the first is already performing.
    let pending = inFlight.get(serializedKey);
    if (!pending) {
      const started = (async () => {
        const installed = await resolveDeclaredProviderInstallation({
          toolId: `provider-installation:${params.contributionKey}`,
          lookupNames: params.installedCheck.lookupNames,
        }, input);
        return installed.status === 'present';
      })();
      void started.catch(() => undefined).finally(() => {
        if (inFlight.get(serializedKey) === started) inFlight.delete(serializedKey);
      });
      inFlight.set(serializedKey, started);
      pending = started;
    }

    return await pending;
  };

  return Object.freeze({
    async read(params: Readonly<{
      machineId: string;
      registry: ProviderContributionRegistryView;
      candidates: readonly Readonly<{ contributionKey: string }>[];
      signal?: AbortSignal;
    }>): Promise<ProviderLocalInstallationReadResult> {
      if (params.signal?.aborted) return { status: 'incomplete', installations: [] };
      const lifetime = createProviderOperationLifetime({ signal: params.signal });
      let incomplete = false;
      const serving = new Set(params.candidates.map((candidate) =>
        canonicalizeProviderContributionKeyV1(candidate.contributionKey)));
      const reads: Promise<ProviderLocalInstallationSummaryV1 | null>[] = [];
      for (const [contributionKey, contribution] of params.registry.providersByContributionKey) {
        const descriptor = contribution.definition.discovery;
        const installedCheck = descriptor?.installedCheck;
        if (
          !installedCheck
          || serving.has(canonicalizeProviderContributionKeyV1(contributionKey))
        ) continue;
        reads.push((async () => {
          const installed = await readInstalled({
            machineId: params.machineId,
            contributionKey,
            installedCheck,
            signal: params.signal,
          });
          if (params.signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
          if (!installed) return null;
          return inspectPresence({
            machineId: params.machineId,
            contributionKey,
            providerName: contribution.definition.name,
            ...(descriptor.presenceCheck ? { presenceCheck: descriptor.presenceCheck } : {}),
            managedStartAvailable:
              contribution.definition.managedRuntime?.kind === 'managed',
            lifetime,
          });
        })());
      }
      const installations = (await Promise.all(reads.map(async read => {
        try {
          return await awaitWithinProviderOperation(read, lifetime);
        } catch {
          // An unavailable OS lookup is incomplete evidence, never absence.
          incomplete = true;
          return null;
        }
      })))
        .filter((value): value is ProviderLocalInstallationSummaryV1 => value !== null)
        .sort((left, right) => left.providerName.localeCompare(right.providerName)
          || left.contributionKey.localeCompare(right.contributionKey));
      return { status: incomplete ? 'incomplete' : 'complete', installations };
    },
  });
}

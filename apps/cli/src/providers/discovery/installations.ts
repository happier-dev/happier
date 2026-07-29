import { createHash } from 'node:crypto';

import {
  canonicalizeProviderContributionKeyV1,
  ProviderInstallationRuntimeStateRecordV1Schema,
  ProviderLocalInstallationSummaryV1Schema,
  serializeProviderInstallationRuntimeStateKeyV1,
  type ProviderLocalInstallationSummaryV1,
} from '@happier-dev/protocol';

import type { ProviderContributionRegistryView } from '@/providers/registry';
import {
  resolveDeclaredProviderInstallation,
  runDeclaredProviderLocalCommand,
  type ProviderLocalCommandRunner,
  type ProviderLocalToolResolver,
} from '@/providers/probe/localCommand';
import {
  replaceProviderRuntimeStateRecord,
  type ProviderRuntimeStateStore,
} from '@/providers/runtimeState';

const DEFAULT_INSTALLATION_RESOLUTION_TIMEOUT_MS = 2_000;
const INSTALLATION_RESOLUTION_TIMED_OUT = Symbol('installation-resolution-timed-out');

export function createProviderLocalInstallationReader(input: ProviderLocalToolResolver & ProviderLocalCommandRunner & Readonly<{
  runtimeStore: Pick<ProviderRuntimeStateStore, 'read' | 'update'>;
  now?: () => number;
  ttlMs?: number;
  installationResolutionTimeoutMs?: number;
}>) {
  const now = input.now ?? Date.now;
  const ttlMs = Math.max(1_000, Math.min(input.ttlMs ?? 30_000, 5 * 60_000));
  const installationResolutionTimeoutMs = Number.isFinite(input.installationResolutionTimeoutMs)
    ? Math.max(10, Math.min(Math.trunc(input.installationResolutionTimeoutMs!), 10_000))
    : DEFAULT_INSTALLATION_RESOLUTION_TIMEOUT_MS;
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
  }>): Promise<ProviderLocalInstallationSummaryV1> => {
    const presence = params.presenceCheck
      ? await runDeclaredProviderLocalCommand({
          toolId: `provider-presence:${params.contributionKey}`,
          lookupNames: params.presenceCheck.lookupNames,
          fixedArgs: params.presenceCheck.fixedArgs,
          parser: params.presenceCheck.parser,
        }, input)
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
  }>): Promise<boolean> => {
    const descriptorFingerprint = createHash('sha256')
      .update(JSON.stringify(params.installedCheck))
      .digest('hex')
      .slice(0, 32);
    const key = {
      machineId: params.machineId,
      contributionKey: params.contributionKey,
      checkId: `installed-${descriptorFingerprint}`,
    };
    const serializedKey = serializeProviderInstallationRuntimeStateKeyV1(key);
    const state = await input.runtimeStore.read();
    const cached = state.installationChecks.find((record) =>
      serializeProviderInstallationRuntimeStateKeyV1(record.key) === serializedKey);
    if (cached && now() < cached.state.observedAt + ttlMs) return cached.state.status === 'present';
    let pending = inFlight.get(serializedKey);
    if (!pending) {
      pending = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const installed = await Promise.race([
          resolveDeclaredProviderInstallation({
            toolId: `provider-installation:${params.contributionKey}`,
            lookupNames: params.installedCheck.lookupNames,
          }, input).catch(() => ({ status: 'absent' as const })),
          new Promise<typeof INSTALLATION_RESOLUTION_TIMED_OUT>((resolve) => {
            timeout = setTimeout(() => resolve(INSTALLATION_RESOLUTION_TIMED_OUT), installationResolutionTimeoutMs);
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        const observedAt = now();
        const record = ProviderInstallationRuntimeStateRecordV1Schema.parse({
          key,
          state: {
            status: installed !== INSTALLATION_RESOLUTION_TIMED_OUT && installed.status === 'present'
              ? 'present'
              : 'absent',
            observedAt,
          },
          lastAccessedAt: observedAt,
        });
        await input.runtimeStore.update((current) => ({
          ...current,
          installationChecks: [...replaceProviderRuntimeStateRecord(
            'installationChecks', current.installationChecks, record,
          )],
        }));
        return installed !== INSTALLATION_RESOLUTION_TIMED_OUT && installed.status === 'present';
      })().finally(() => inFlight.delete(serializedKey));
      inFlight.set(serializedKey, pending);
    }
    return pending;
  };

  return Object.freeze({
    async read(params: Readonly<{
      machineId: string;
      registry: ProviderContributionRegistryView;
      candidates: readonly Readonly<{ contributionKey: string }>[];
    }>): Promise<readonly ProviderLocalInstallationSummaryV1[]> {
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
          });
          if (!installed) return null;
          return inspectPresence({
            machineId: params.machineId,
            contributionKey,
            providerName: contribution.definition.name,
            ...(descriptor.presenceCheck ? { presenceCheck: descriptor.presenceCheck } : {}),
            managedStartAvailable: descriptor.managedStart !== undefined,
          });
        })());
      }
      return (await Promise.all(reads))
        .filter((value): value is ProviderLocalInstallationSummaryV1 => value !== null)
        .sort((left, right) => left.providerName.localeCompare(right.providerName)
          || left.contributionKey.localeCompare(right.contributionKey));
    },
  });
}

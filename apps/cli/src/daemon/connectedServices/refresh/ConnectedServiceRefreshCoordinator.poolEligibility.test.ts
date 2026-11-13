import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  buildQualifiedPluginContributionKey,
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';

import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../quotas/ConnectedServiceQuotasCoordinator';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { resolveConnectedServiceAuthForLaunch } from '../resolveConnectedServiceAuthForLaunch';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createBuiltInQualifiedRefreshHarness } from './ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { DEFAULT_CONNECTED_SERVICE_QUOTA_FRESHNESS_MS } from '../quotas/resolveConnectedServiceQuotasDaemonOptions';

const healthyId = '7e9ced1f-60ac-4618-bcf0-31adc1c2e4aa';
const activeId = '92fe29be-575b-4551-8e90-edaacc3ec7a4';
const memberIds = [healthyId, '97bd5614-8970-4068-87f2-1447de69d604',
  '705530f2-81e8-4ba2-bc7b-7929a4b95b5a', activeId];

afterEach(() => vi.unstubAllGlobals());

describe('Codex pool selection and spawn pre-turn admission', () => {
  it('re-observes accepted exhausted Home quota on launch before its future reset', async () => {
    const harness = await createBuiltInQualifiedRefreshHarness({ primaryAccountId: healthyId });
    let now = harness.now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const resetAtMs = now + 7 * 24 * 60 * 60_000;
      // Provider HTTP and Home storage are boundaries. The Codex quota leaf,
      // quota coordinator, usage store, hydration and selector remain real.
      const providerRequests: string[] = [];
      vi.stubGlobal('fetch', async (url: string | URL | Request) => {
        providerRequests.push(String(url));
        return new Response(JSON.stringify({ rate_limit: {
          primary_window: { used_percent: 0, reset_at: resetAtMs / 1_000 },
        } }));
      });
      const group = QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: { service: harness.service, groupId: 'codex-pool' }, incarnation: 'qa-pool',
        displayName: 'Codex pool', policy: { autoSwitch: true, strategy: 'priority' },
        activeConnectedAccountId: healthyId, generation: 7, runtimeStateRevision: 0,
        state: {}, createdAt: 1, updatedAt: 1,
        members: [{ v: 1, connectedAccountId: healthyId, priority: 0, enabled: true,
          state: {}, createdAt: 1, updatedAt: 1 }],
      });
      const listed = QualifiedConnectedAccountListResponseV4Schema.parse({ service: harness.service,
        accounts: [{ ref: { service: harness.service, accountId: healthyId }, status: 'connected',
          authenticationModeId: 'oauth', configurationReady: false, configurationRevision: null,
          revisionSemantics: 'revisioned', credentialRevision: harness.firstRevision,
          scopes: [], providerIdentity: { accountId: 'work' } }],
      });
      const recordKey = { providerId: 'openai-codex', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
      const acceptedQuota = ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey), providerId: recordKey.providerId,
        accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: DEFAULT_CONNECTED_SERVICE_QUOTA_FRESHNESS_MS,
        source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'weekly', label: 'Weekly', remainingPct: 0, utilizationPct: 100,
          used: 100, limit: 100, unit: 'unknown', resetsAt: resetAtMs, status: 'ok', details: {} }],
      });
      const accountUsageStore = createProviderAccountUsageStore();
      const quotas = new ConnectedServiceQuotasCoordinator({ api: harness.api, credentials: harness.credentials,
        quotaFetchers: [], randomBytes: length => new Uint8Array(length), now: () => now, accountUsageStore,
        qualifiedConnectedAccountRuntime: {
          resolvePeerClass: () => 'advertised_v4', establishedRuntimeOwner: harness.establishedRuntimeOwner,
          listScheduledAccounts: async () => listed.accounts,
          listGroupQuotaTargets: async () => listed.accounts.map(profile => ({ profile, groupGeneration: group.generation })),
          readQuota: async ({ ref }) => ({
            ref, sourceResolution: { source: { ref, bindingKind: 'account' }, recordId: acceptedQuota.recordId,
              providerAccountId: 'work', fetchedAt: acceptedQuota.fetchedAtMs, staleAfterMs: acceptedQuota.staleAfterMs },
            content: { t: 'plain', v: projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({ snapshot: acceptedQuota, ref }) },
            metadata: { fetchedAt: acceptedQuota.fetchedAtMs, staleAfterMs: acceptedQuota.staleAfterMs, status: 'ok' },
          }),
          writeProviderAccountUsage: async () => ({ success: true }),
        },
      });
      const forbiddenMutation = async (): Promise<never> => { throw new Error('Keeping the current member needs no pool mutation'); };
      const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
        token: harness.credentials.token, nowMs: () => now, accountUsageStore,
        hydrateQuotaSnapshotsForGroup: request => quotas.hydrateQualifiedGroupQuotaSnapshots(request),
        probeQuotaSnapshotsForGroup: request => quotas.probeGroupQuotaSnapshots({ ...request,
          serviceId: buildQualifiedPluginContributionKey(request.serviceId) }),
        api: { readGroup: async () => group, listAccounts: async () => listed,
          setActiveAccount: forbiddenMutation, updateRuntimeState: forbiddenMutation },
        applyGeneration: async () => ({ ok: true }),
      });
      const request = { serviceId: harness.service, groupId: group.ref.groupId, modelId: 'gpt-6-luna' };
      expect((await coordinator.readSelection(request)).selection.excluded)
        .toContainEqual({ profileId: healthyId, reason: 'quota_exhausted', retryAtMs: resetAtMs });
      await expect(coordinator.switchBeforeTurn({ ...request, reason: 'soft_threshold',
        observedProfileId: healthyId, allowCurrentProfileRetry: true }))
        .resolves.toMatchObject({ status: 'no_eligible_member' });
      expect(providerRequests).toEqual([]);
      // Restoration does not change the accepted Home row. An explicit launch
      // after its existing freshness window must observe the provider again.
      now += acceptedQuota.staleAfterMs + 1;
      await expect(coordinator.switchBeforeTurn({ ...request, reason: 'soft_threshold',
        observedProfileId: healthyId, allowCurrentProfileRetry: true }))
        .resolves.toMatchObject({ activeProfileId: healthyId });
      expect((await coordinator.readSelection(request)).selection.selected?.profileId).toBe(healthyId);
      expect(providerRequests.filter(url => new URL(url).pathname.endsWith('/usage'))).toHaveLength(1);
      expect(now).toBeLessThan(resetAtMs);
    } finally {
      clock.mockRestore();
      await harness.dispose();
    }
  });

  it.each(['unknown', 'probe_failed', 'accepted_quota', 'accepted_quota_stale_local', 'auth_invalid', 'model_not_entitled', 'usage_limit'] as const)(
    'uses the selected candidate own credential and eligibility (%s)', async disposition => {
      const harness = await createBuiltInQualifiedRefreshHarness({ primaryAccountId: healthyId });
      try {
        // Only provider HTTP and Account storage/native application boundaries are substituted.
        // A different member needing reauth must not make a healthy candidate depend on refresh HTTP.
        const providerRequests: string[] = [];
        vi.stubGlobal('fetch', async (url: string | URL | Request) => {
          providerRequests.push(String(url));
          return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 });
        });
        const resetAtMs = harness.now + 60_000;
        let group = QualifiedConnectedAccountGroupV4Schema.parse({
          v: 1, ref: { service: harness.service, groupId: 'codex-pool' }, incarnation: 'qa-pool',
          displayName: 'Codex pool', policy: { autoSwitch: true, strategy: 'priority' },
          activeConnectedAccountId: activeId, generation: 7, runtimeStateRevision: 0,
          state: {}, createdAt: 1, updatedAt: 1,
          members: memberIds.map((connectedAccountId, priority) => ({
            v: 1, connectedAccountId, priority, enabled: true, createdAt: 1, updatedAt: 1,
            state: connectedAccountId !== healthyId ? {} : {
              modelUnavailableUntilMsByModelId: {
                'gpt-6.1-luna': harness.now - 1,
                ...(disposition === 'model_not_entitled' ? { 'gpt-6-luna': resetAtMs } : {}),
              },
              lastFailureKind: 'plan', lastFailureCode: 'model_not_entitled',
              ...(disposition === 'usage_limit' ? { quotaExhaustedUntilMs: resetAtMs } : {}),
            },
          })),
        });
        const listed = QualifiedConnectedAccountListResponseV4Schema.parse({ service: harness.service,
          accounts: memberIds.map(accountId => ({ ref: { service: harness.service, accountId },
            status: accountId === healthyId && disposition !== 'auth_invalid' ? 'connected' : 'needs_reauth',
            authenticationModeId: 'oauth', configurationReady: false, configurationRevision: null,
            revisionSemantics: 'revisioned', credentialRevision: harness.firstRevision, scopes: [],
            providerIdentity: { accountId: 'work' },
          })),
        });
        const accountUsageStore = createProviderAccountUsageStore();
        const recordKey = { providerId: 'openai-codex', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
        const acceptedQuota = ProviderAccountUsageSnapshotV1Schema.parse({
          v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey), providerId: recordKey.providerId,
          accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: harness.now,
          fetchedAtMs: harness.now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
          meters: [{ meterId: 'weekly', label: 'Weekly', remainingPct: 0, utilizationPct: 100,
            used: 100, limit: 100, unit: 'unknown', resetsAt: resetAtMs, status: 'ok', details: {} }],
        });
        if (disposition === 'accepted_quota_stale_local') {
          accountUsageStore.recordSnapshot(ProviderAccountUsageSnapshotV1Schema.parse({ ...acceptedQuota,
            observedAtMs: harness.now - 120_000, fetchedAtMs: harness.now - 120_000,
            meters: acceptedQuota.meters.map(meter => ({ ...meter, remainingPct: 100, utilizationPct: 0, used: 0 })),
          }), { sources: [{ serviceId: buildQualifiedPluginContributionKey(harness.service), profileId: healthyId,
            bindingKind: 'group_member', groupId: group.ref.groupId, groupGeneration: group.generation }] });
        }
        const hasAcceptedQuota = disposition === 'accepted_quota' || disposition === 'accepted_quota_stale_local';
        const quotaReads: string[] = [];
        const quotas = new ConnectedServiceQuotasCoordinator({ api: harness.api, credentials: harness.credentials,
          quotaFetchers: [], randomBytes: length => new Uint8Array(length), now: () => harness.now,
          accountUsageStore,
          ...(disposition === 'probe_failed' || hasAcceptedQuota ? { qualifiedConnectedAccountRuntime: {
            resolvePeerClass: () => 'advertised_v4' as const,
            establishedRuntimeOwner: harness.establishedRuntimeOwner,
            listScheduledAccounts: async () => listed.accounts,
            listGroupQuotaTargets: async ({ accountIds }) => listed.accounts
              // Omitted accountIds means every member, as the coordinator port documents.
              .filter(profile => accountIds === undefined || accountIds.includes(profile.ref.accountId))
              .map(profile => ({ profile, groupGeneration: group.generation })),
            readQuota: async ({ ref }) => {
              quotaReads.push(ref.accountId);
              return !hasAcceptedQuota ? null : {
                ref, sourceResolution: { source: { ref, bindingKind: 'account' as const }, recordId: acceptedQuota.recordId,
                  providerAccountId: 'work', fetchedAt: harness.now, staleAfterMs: acceptedQuota.staleAfterMs },
                content: { t: 'plain' as const, v: projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({ snapshot: acceptedQuota, ref }) },
                metadata: { fetchedAt: harness.now, staleAfterMs: acceptedQuota.staleAfterMs, status: 'ok' as const },
              };
            },
            writeProviderAccountUsage: async () => ({ success: true as const }),
          } } : {}),
        });
        const probeResults: Awaited<ReturnType<typeof quotas.probeGroupQuotaSnapshots>>[] = [];
        const applied: string[] = [];
        const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
          token: harness.credentials.token, nowMs: () => harness.now, accountUsageStore,
          ...{ hydrateQuotaSnapshotsForGroup: (request: Parameters<typeof quotas.hydrateQualifiedGroupQuotaSnapshots>[0]) =>
            quotas.hydrateQualifiedGroupQuotaSnapshots(request) },
          api: {
            readGroup: async () => group, listAccounts: async () => listed,
            setActiveAccount: async ({ mutation: raw }) => {
              const mutation = QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(raw);
              expect(mutation.expectedSource?.connectedAccountId).toBe(activeId);
              group = QualifiedConnectedAccountGroupV4Schema.parse({ ...group,
                activeConnectedAccountId: mutation.connectedAccountId, generation: group.generation + 1,
                runtimeStateRevision: group.runtimeStateRevision + 1 });
              return group;
            },
            updateRuntimeState: async () => { throw new Error('Pre-turn admission must not stamp another failure'); },
          },
          probeQuotaSnapshotsForGroup: async request => {
            const result = await quotas.probeGroupQuotaSnapshots({ ...request,
              serviceId: buildQualifiedPluginContributionKey(request.serviceId) });
            probeResults.push(result);
            return result;
          },
          prepareCandidateForSwitch: candidate => harness.coordinator.prepareConnectedServiceAuthGroupCandidateForSwitch({
            ...candidate, serviceId: 'openai-codex',
          }),
          applyGeneration: async ({ activeProfileId }) => {
            if (!activeProfileId) throw new Error('Expected selected Account at native application boundary');
            applied.push(activeProfileId); return { ok: true };
          },
        });
        const request = { serviceId: harness.service, groupId: group.ref.groupId,
          modelId: 'gpt-6-luna', providerLimitId: 'gpt-6-luna' };
        const status = await coordinator.readSelection(request);
        if (disposition === 'unknown' || disposition === 'probe_failed') {
          expect(status.selection).toMatchObject({ reason: 'selected', selected: { profileId: healthyId } });
          expect(status.selection.decisionTrace.candidates.find(candidate => candidate.profileId === healthyId))
            .toMatchObject({ quotaEvidence: { status: 'stale_or_missing' } });
          // Read-only eligibility does not prove that an unavailable provider probe completed.
          await expect(coordinator.switchBeforeTurn({ ...request, reason: 'auth_expired', observedProfileId: activeId }))
            .resolves.toMatchObject({ status: 'quota_proof_unavailable', activeProfileId: activeId });
          expect(applied).toEqual([]);
        } else {
          const exclusion = { profileId: healthyId,
            reason: disposition === 'model_not_entitled' ? 'plan_unavailable'
              : disposition === 'usage_limit' || hasAcceptedQuota ? 'quota_exhausted' : 'auth_invalid',
            ...(disposition === 'auth_invalid' ? {} : { retryAtMs: resetAtMs }),
          };
          expect(status.selection).toMatchObject({ selected: null, reason: 'no_eligible_members' });
          expect(status.selection.excluded).toContainEqual(exclusion);
          const probeIsUnavailable = disposition === 'model_not_entitled' || disposition === 'usage_limit';
          await expect(coordinator.switchBeforeTurn({ ...request, reason: 'auth_expired', observedProfileId: activeId }))
            .resolves.toMatchObject(probeIsUnavailable
              ? { status: 'quota_proof_unavailable' }
              : { status: 'no_eligible_member', excluded: expect.arrayContaining([exclusion]) });
          expect(applied).toEqual([]);
          if (disposition !== 'model_not_entitled') {
            await expect(resolveConnectedServiceAuthForLaunch({
              agentId: 'codex', modelId: request.modelId,
              connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
                [buildQualifiedPluginContributionKey(harness.service)]: {
                  source: 'connected', selection: 'group', groupId: group.ref.groupId,
                },
              } },
              materializationKey: 'pool-refusal', activeServerDir: harness.happyHomeDir,
              baseDir: harness.happyHomeDir, credentials: harness.credentials, api: harness.api,
              nowMs: () => harness.now, accountUsageStore,
              qualifiedConnectedAccountApi: { readGroup: async () => group, listAccounts: async () => listed },
              resolveQualifiedPurposeBindingSnapshot: bindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: 'codex', bindings, contributions: harness.registry.contributes,
              }),
            }, async () => coordinator)).rejects.toMatchObject(probeIsUnavailable ? {
              code: 'connected_service_auth_group_quota_probe_incomplete',
              result: { status: 'incomplete', reason: 'probe_unavailable' },
            } : {
              code: 'no_eligible_member', excluded: expect.arrayContaining([exclusion]),
              message: expect.stringContaining(`${exclusion.profileId}:${exclusion.reason}`),
            });
          }
        }
        if (disposition === 'probe_failed') {
          // Provider-directed backoff accounts for this member without claiming usable quota.
          expect(probeResults).toContainEqual(expect.objectContaining({
            status: 'complete', requestedProfileCount: 1, completedProfileCount: 0,
            deferredProfiles: [{ profileId: healthyId, retryAtMs: expect.any(Number) }],
          }));
          expect(providerRequests).toHaveLength(1);
          expect(providerRequests[0]).toContain('/usage');
        } else {
          expect(providerRequests).toEqual([]);
        }
        if (hasAcceptedQuota) expect(new Set(quotaReads)).toEqual(new Set([healthyId]));
      } finally { await harness.dispose(); }
    },
  );
});

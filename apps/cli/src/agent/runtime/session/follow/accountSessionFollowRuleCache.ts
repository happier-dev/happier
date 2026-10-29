import axios from '@/api/client/credentialAxios';
import { ListSessionFollowRulesResponseV1Schema, SESSION_FOLLOW_RULES_ROUTE_V1, type ListSessionFollowRulesResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { createAutomationAccountEncryptionMaterialSnapshotV1, isAvailableE2eeAutomationAccountEncryptionV1, resolveValidatedAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { StoredCredentials } from '@/persistence';
import { createSessionFollowRuleCache, type SessionFollowRuleInvalidation } from './sessionFollowRuleCache';
import { SESSION_FOLLOW_HTTP_PATHS_V1, SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import { projectAccountEncryptionIdentity, sameAccountEncryptionIdentity, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { logger } from '@/ui/logger';
import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { createSessionFollowOriginalWork } from './sessionFollowOriginalWork';

export type SessionFollowReceiverSourceRanges = Readonly<{
  rules: readonly Pick<ListSessionFollowRulesResponseV1['rules'][number], 'ruleId' | 'version' | 'receiver' | 'sources'>[];
  sourceRanges?: ListSessionFollowRulesResponseV1['sourceRanges'];
}>;
export type SessionFollowReceiverSourceRangesRead = Readonly<{ status: 'available'; value: SessionFollowReceiverSourceRanges }>
  | Readonly<{ status: 'unavailable'; reason: 'account-retired' | 'source-ranges-unavailable'; httpStatus?: number }>;

/** Own-Account transport captured by the daemon; restricted Session credentials never enter this reader. */
export function createAccountSessionFollowRuleCache(input: Readonly<{
  accountId: string; credentials: StoredCredentials; serverHttpBaseUrl: string; signal: AbortSignal;
  isCurrent: () => boolean | Promise<boolean>; subscribeInvalidation: (listener: (change?: SessionFollowRuleInvalidation) => void) => () => void;
  subscribeSourceInvalidation?: (listener: (sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) => void) => () => void;
}>) {
  if (readAccountIdFromToken(input.credentials.token) !== input.accountId) throw new Error('follow_rule_account_mismatch');
  let retired = false;
  const originalWork = createSessionFollowOriginalWork();
  let observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | undefined;
  let encryptionIdentity: AccountEncryptionIdentity | null = null;
  type RangeRead = { read: Promise<SessionFollowReceiverSourceRangesRead>; result?: SessionFollowReceiverSourceRangesRead };
  const ranges = new Map<string, Map<string | null, RangeRead>>();
  let rangesObservable = true;
  let observedRules: readonly OpenedSessionFollowRuleV1[] | null = null;
  let receiverSignatures = new Map<string, string>();
  const withdrawRanges = (reset: boolean) => {
    rangesObservable = false;
    observedRules = null;
    if (reset) ranges.clear();
    else for (const receiverRanges of ranges.values()) for (const [key, entry] of receiverRanges) {
      // Only completed, available projections can be reconciled. An unfinished
      // read must not be resurrected under a later admitted rule observation.
      if (entry.result?.status !== 'available' || entry.result.value.sourceRanges?.status !== 'available') receiverRanges.delete(key);
    }
  };
  const observeRules = (rules: readonly OpenedSessionFollowRuleV1[]) => {
    if (rules === observedRules && rangesObservable) return;
    const byReceiver = new Map<string, OpenedSessionFollowRuleV1[]>();
    for (const rule of rules) if (rule.receiver.kind === 'session') {
      const rows = byReceiver.get(rule.receiver.sessionId) ?? [];
      rows.push(rule);
      byReceiver.set(rule.receiver.sessionId, rows);
    }
    const signatures = new Map<string, string>();
    for (const [receiver, rows] of byReceiver) signatures.set(receiver, JSON.stringify(rows.map(rule => [
      rule.ruleId, rule.inception?.createdAt ?? null, rule.inception?.accountChangeCursor ?? null,
      [...(rule.sources ?? [])].sort((a, b) => a.sourceSessionId.localeCompare(b.sourceSessionId)).map(source => [
        source.sourceSessionId, source.delivered.transcriptSeq, source.delivered.readyEventSeq,
        source.delivered.agentStateVersion, source.delivered.turn?.id ?? null, source.delivered.turn?.status ?? null,
      ]),
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
    for (const [receiver, receiverRanges] of ranges) {
      if (!signatures.has(receiver) || signatures.get(receiver) !== receiverSignatures.get(receiver)) {
        ranges.delete(receiver);
        continue;
      }
      const versions = new Map(byReceiver.get(receiver)!.map(rule => [rule.ruleId, rule.version]));
      for (const entry of receiverRanges.values()) if (entry.result?.status === 'available') {
        // Authoring edits do not change server discovery. Keep accepted fresh
        // progress, but bind its identities to the newly opened rule versions.
        entry.result = { status: 'available', value: { ...entry.result.value,
          rules: entry.result.value.rules.map(rule => ({ ...rule, version: versions.get(rule.ruleId) ?? rule.version })) } };
      }
    }
    receiverSignatures = signatures;
    observedRules = rules;
    rangesObservable = true;
  };
  const invalidateReceiver = (destinationSessionId: string) => {
    ranges.delete(destinationSessionId);
    originalWork.rangeAvailable(destinationSessionId);
  };
  const current = async () => {
    if (retired || input.signal.aborted) return false;
    const accountCurrent = await input.isCurrent();
    if (!accountCurrent || retired || input.signal.aborted) return false;
    if (encryptionIdentity && observation) {
      const observed = await observation.read(input.signal, { requireLiveObservation: true });
      if (!sameAccountEncryptionIdentity(observed, encryptionIdentity) || !observation.isCurrent(encryptionIdentity)) return false;
    }
    return !retired && !input.signal.aborted;
  };
  const cache = createSessionFollowRuleCache({
    signal: input.signal, isCurrent: () => !input.signal.aborted,
    subscribeInvalidation: listener => input.subscribeInvalidation(change => {
      if (change?.full !== false) originalWork.changed(change === undefined || change.continuityReset === true);
      if (change?.full !== false) withdrawRanges(change === undefined || change.continuityReset === true);
      else for (const receiver of change.receiverSessionIds ?? []) invalidateReceiver(receiver);
      listener(change);
    }),
    onObserved: observeRules,
    read: async () => {
      if (!await current()) return null;
      let identity: AccountEncryptionIdentity | null = null;
      const encryption = await resolveValidatedAutomationAccountEncryptionV1({ signal: input.signal,
        resolveAccountEncryptionCurrentness: async signal => {
          const fact = await fetchAccountEncryptionCurrentness({ token: input.credentials.token,
            serverBaseUrl: input.serverHttpBaseUrl, signal });
          identity = projectAccountEncryptionIdentity(fact);
          return fact;
        },
        resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(input.credentials),
      });
      if (encryption.kind !== 'available' || !identity || !await current()) return null;
      // The installed credential fence does not observe Account mode/key
      // transitions. Retain this read's witness through the same shared channel
      // as requester custody, and hold if that channel is unavailable.
      observation ??= acquireRequesterAccountEncryptionCurrentness({ accountId: input.accountId,
        token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl });
      encryptionIdentity = identity;
      if (!await current()) return null;
      const options = {
        headers: { Authorization: `Bearer ${input.credentials.token}` }, signal: input.signal, validateStatus: () => true,
      };
      const [response, defaultsResponse] = await Promise.all([
        axios.get<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_RULES_ROUTE_V1}`, options),
        axios.get<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_HTTP_PATHS_V1.preferences}`, options),
      ]);
      if (response.status !== 200 || defaultsResponse.status !== 200 || !await current()) return null;
      const parsed = ListSessionFollowRulesResponseV1Schema.safeParse(response.data);
      const defaults = SessionAutoFollowPreferencesResponseSchema.safeParse(defaultsResponse.data);
      if (!parsed.success || !defaults.success) return null;
      return { mode: encryption.witness.mode,
        material: isAvailableE2eeAutomationAccountEncryptionV1(encryption) ? encryption.material.material : null,
        rules: parsed.data.rules, defaultPreferences: defaults.data };
    },
  });
  // Requester custody already retains this exact Account feed. Only an exact
  // receiver-progress hint or continuity reset withdraws held source ranges;
  // generic Session arrivals do not change accepted rule progress.
  const observeSourceChange = (sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) => {
    if (sourceSessionId === null) { ranges.clear(); originalWork.changed(true); }
    else if (receiver) invalidateReceiver(sourceSessionId);
    else {
      if (sourceChanged !== false) originalWork.sourceAvailable(sourceSessionId);
      if (availabilityChanged !== false && originalWork.hasHeldReceiver(sourceSessionId)) {
        logger.debug('[Session Follow] Receiver-held recovery', { sessionId: sourceSessionId,
          reason: availabilityChanged === true ? 'availability_changed' : 'legacy_unqualified' });
        originalWork.available(sourceSessionId);
      }
    }
  };
  const releaseSources = input.signal.aborted ? undefined : input.subscribeSourceInvalidation?.(observeSourceChange);
  const dispose = () => {
    if (retired) return;
    retired = true;
    cache.dispose();
    originalWork.dispose();
    ranges.clear();
    observedRules = null;
    receiverSignatures.clear();
    releaseSources?.();
    encryptionIdentity = null;
    const retiring = observation;
    observation = undefined;
    input.signal.removeEventListener('abort', dispose);
    void retiring?.dispose().catch(() => logger.warn('[Session Follow] Rule encryption observation retirement unavailable'));
  };
  input.signal.addEventListener('abort', dispose, { once: true });
  if (input.signal.aborted) dispose();
  return {
    originalWork,
    /** Hosts without a captured Account feed forward their existing push here. */
    observeSourceChange(sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) {
      if (!input.subscribeSourceInvalidation) observeSourceChange(sourceSessionId, receiver, availabilityChanged, sourceChanged);
    },
    async read(options?: Parameters<typeof cache.read>[0]) {
      try {
        if (!await current()) return { status: 'unavailable', reason: 'account-retired' } as const;
        if (options?.refresh) withdrawRanges(false);
        return await cache.read(options, current);
      } catch { return { status: 'unavailable', reason: 'account-retired' } as const; }
    },
    async hasEnabledSessionReceiver(sessionId: string): Promise<boolean> {
      try { return await cache.hasEnabledSessionReceiver(sessionId, current); }
      catch { return false; }
    },
    /** Held progress/inception projection, refreshed by its existing exact receiver push. */
    async readReceiverSourceRanges(receiver: Readonly<{ destinationSessionId: string; sourceSessionId?: string }>): Promise<SessionFollowReceiverSourceRangesRead> {
      if (!await current()) return { status: 'unavailable', reason: 'account-retired' };
      if (!rangesObservable) return { status: 'unavailable', reason: 'source-ranges-unavailable' };
      let receiverRanges = ranges.get(receiver.destinationSessionId);
      if (!receiverRanges) {
        receiverRanges = new Map();
        ranges.set(receiver.destinationSessionId, receiverRanges);
      }
      const key = receiver.sourceSessionId ?? null;
      let entry = receiverRanges.get(key);
      if (!entry) {
        const read = (async (): Promise<SessionFollowReceiverSourceRangesRead> => {
          const response = await axios.get<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_RULES_ROUTE_V1}`, {
            headers: { Authorization: `Bearer ${input.credentials.token}` }, signal: input.signal,
            params: receiver, validateStatus: () => true,
          });
          const parsed = response.status === 200 ? ListSessionFollowRulesResponseV1Schema.safeParse(response.data) : null;
          // Keep only progress identities/frontiers, never another copy of the
          // private definition corpus. Failed reads stay held until real change.
          return parsed?.success ? { status: 'available', value: {
            rules: parsed.data.rules.filter(rule => rule.receiver.kind === 'session'
              && rule.receiver.sessionId === receiver.destinationSessionId).map(({ ruleId, version, receiver, sources }) => ({ ruleId, version, receiver,
              ...(sources ? { sources } : {}) })),
            ...(parsed.data.sourceRanges ? { sourceRanges: parsed.data.sourceRanges } : {}),
          } } : { status: 'unavailable', reason: 'source-ranges-unavailable', httpStatus: response.status };
        })();
        entry = { read };
        const pendingEntry = entry;
        void read.then(result => { pendingEntry.result = result; }, () => {});
        receiverRanges.set(key, entry);
      }
      const result = await entry.read;
      if (!await current()) return { status: 'unavailable', reason: 'account-retired' };
      return rangesObservable && ranges.get(receiver.destinationSessionId) === receiverRanges && receiverRanges.get(key) === entry
        ? entry.result ?? result : { status: 'unavailable', reason: 'source-ranges-unavailable' };
    },
    dispose,
  };
}

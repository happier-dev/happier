import type { AgentSessionNativeHomeService, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { classifyClaudeNativeTranscriptRow, type ClaudeCredentialOrganizationObservation } from '../../../transcripts/nativeSemanticProjection.js';
import { readClaudeNativeUsageIdentity } from '../native/accountIdentity.js';
import { CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME, parseClaudeCodeNativeAuthProvenance } from '../native/provenance.js';
import { isClaudePrimaryNativeActivity } from '../../../runtime/nativeActivity.js';
import { mapClaudeRuntimeRateLimitsToUsageObservation, type NormalizedClaudeRuntimeRateLimitsObservation } from './usage.js';
import { readClaudeConnectedServiceRuntimeServiceFromEnv, readClaudeSubscriptionRuntimeAuthSelectionFromEnv } from './env.js';

export type ClaudeIssuedRequestIdentity = Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration: number | null;
  credentialRevision: string | null;
  sourceProviderAccountId: string | null;
  sourceProviderOrganizationId: string | null;
  providerReportedOrganizationId?: string | null;
}>;

export type ClaudeRuntimeAuthIdentity = ReturnType<typeof createClaudeRuntimeAuthIdentity>;

/** Request identity, quota windows and ordered provider evidence share one provider-local owner. */
export function createClaudeRuntimeAuthIdentity(input: Readonly<{
  launchEnv: Readonly<Record<string, string>>;
  nativeHome?: AgentSessionNativeHomeService;
  logger: Readonly<{ warn(message: string, details?: unknown): void }>;
}>) {
  const serviceId = readClaudeConnectedServiceRuntimeServiceFromEnv(input.launchEnv);
  const selection = readClaudeSubscriptionRuntimeAuthSelectionFromEnv(input.launchEnv);
  let issued: ClaudeIssuedRequestIdentity | null = null;
  let issuedUsageIdentity: ReturnType<typeof readClaudeNativeUsageIdentity> | undefined;
  let currentNativeSessionId: string | null = null;
  const organizations = new Map<string, ClaudeCredentialOrganizationObservation[]>();
  let quotaObservation: NormalizedClaudeRuntimeRateLimitsObservation = { status: 'not_loaded' };
  const unknownIdentity = (): ClaudeIssuedRequestIdentity => ({
    serviceId: serviceId ?? 'happier.agent.claude/claude-subscription', profileId: null,
    groupId: selection?.kind === 'group' ? selection.groupId : null,
    groupGeneration: null, credentialRevision: null,
    sourceProviderAccountId: null, sourceProviderOrganizationId: null,
  });
  return {
    async captureRequest(): Promise<void> {
      quotaObservation = { status: 'not_loaded' };
      issuedUsageIdentity = { identity: null, credentialProof: null };
      // Clear before the read: failed reads must never reuse the preceding request's identity.
      issued = unknownIdentity();
      try {
        if (!input.nativeHome) return;
        const files = await input.nativeHome.readFiles(['.claude.json', '.credentials.json', CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME]);
        const parse = (fileId: string): unknown => {
          if (!files[fileId]) return null;
          try { return JSON.parse(new TextDecoder().decode(files[fileId])); }
          catch { return null; }
        };
        issuedUsageIdentity = readClaudeNativeUsageIdentity(parse('.claude.json'), parse('.credentials.json'));
        const native = issuedUsageIdentity.identity;
        const provenance = parseClaudeCodeNativeAuthProvenance(parse(CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME));
        issued = { ...unknownIdentity(),
          profileId: provenance?.credentialProfileId ?? null,
          groupId: provenance?.groupId ?? (selection?.kind === 'group' ? selection.groupId : null),
          groupGeneration: provenance?.generation ?? null, credentialRevision: provenance?.credentialRevision ?? null,
          sourceProviderAccountId: native?.providerAccountId ?? null,
          sourceProviderOrganizationId: native?.providerOrganizationId ?? null };
      } catch {
        input.logger.warn('[Claude] Request account identity is unavailable');
      }
    },
    readUsageIdentity() { return issuedUsageIdentity; },
    // Claude emits the whole statusline for unrelated model/context changes. Publish only
    // changed quota facts at this admitted producer, before account qualification awaits.
    observeQuotaEvidence(evidence: unknown): NormalizedClaudeRuntimeRateLimitsObservation | null {
      const observation = mapClaudeRuntimeRateLimitsToUsageObservation(evidence);
      if (observation.status === 'not_loaded' || !isClaudePrimaryNativeActivity(evidence)) return observation;
      const nextById = new Map(observation.meters.map(meter => [meter.meterId, meter]));
      if (quotaObservation.status === observation.status
        && quotaObservation.meters.length === observation.meters.length
        && quotaObservation.meters.every(meter => {
          const next = nextById.get(meter.meterId);
          return next && meter.meterId === next.meterId && meter.label === next.label
            && meter.utilizationPct === next.utilizationPct && meter.resetsAtMs === next.resetsAtMs
            && meter.source === next.source && meter.credits?.exhausted === next.credits?.exhausted;
        })) {
        // An SDK event is provider revalidation. Repeated statusline fields are not.
        return evidence && typeof evidence === 'object' && 'type' in evidence && evidence.type === 'rate_limit_event'
          ? quotaObservation : null;
      }
      quotaObservation = observation;
      return observation;
    },
    readQuotaWindows() {
      return quotaObservation.status === 'not_loaded' ? [] : quotaObservation.meters;
    },
    observeSource(input: Parameters<NonNullable<AgentSessionRuntime['observeSourceTranscript']>>[0]): ClaudeCredentialOrganizationObservation | null {
      if (serviceId !== 'happier.agent.claude/claude-subscription') return null;
      const observation = classifyClaudeNativeTranscriptRow(input.row).credentialOrganization;
      if (!observation || observation.nativeSessionId !== input.providerSessionId) return null;
      currentNativeSessionId = input.providerSessionId;
      const history = organizations.get(currentNativeSessionId) ?? [];
      history.push(observation);
      organizations.set(currentNativeSessionId, history);
      return input.phase === 'initial_replay' || selection?.kind !== 'group' ? null : observation;
    },
    readFailure(occurredAtMs: number, nativeSessionId?: string | null): ClaudeIssuedRequestIdentity | null {
      if (serviceId !== 'happier.agent.claude/claude-subscription') return null;
      let evidence: ClaudeCredentialOrganizationObservation | null = null;
      for (const observation of organizations.get(nativeSessionId ?? currentNativeSessionId ?? '') ?? []) {
        if (observation.observedAtMs <= occurredAtMs && (!evidence || observation.observedAtMs >= evidence.observedAtMs)) evidence = observation;
      }
      return { ...(issued ?? unknownIdentity()), providerReportedOrganizationId: evidence?.providerOrganizationId ?? null };
    },
  };
}

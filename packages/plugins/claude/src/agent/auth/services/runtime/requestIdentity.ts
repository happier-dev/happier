import type { AgentSessionNativeHomeService, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { classifyClaudeNativeTranscriptRow, type ClaudeCredentialOrganizationObservation } from '../../../transcripts/nativeSemanticProjection.js';
import { readClaudeNativeAccountIdentity } from '../native/accountIdentity.js';
import { CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME, parseClaudeCodeNativeAuthProvenance } from '../native/provenance.js';
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

/** Request identity and ordered provider evidence share one provider-local owner. */
export function createClaudeRuntimeAuthIdentity(input: Readonly<{
  launchEnv: Readonly<Record<string, string>>;
  nativeHome?: AgentSessionNativeHomeService;
  logger: Readonly<{ warn(message: string, details?: unknown): void }>;
}>) {
  const serviceId = readClaudeConnectedServiceRuntimeServiceFromEnv(input.launchEnv);
  const selection = readClaudeSubscriptionRuntimeAuthSelectionFromEnv(input.launchEnv);
  let issued: ClaudeIssuedRequestIdentity | null = null;
  let currentNativeSessionId: string | null = null;
  const organizations = new Map<string, ClaudeCredentialOrganizationObservation[]>();
  const unknownIdentity = (): ClaudeIssuedRequestIdentity => ({
    serviceId: serviceId ?? 'happier.agent.claude/claude-subscription', profileId: null,
    groupId: selection?.kind === 'group' ? selection.groupId : null,
    groupGeneration: null, credentialRevision: null,
    sourceProviderAccountId: null, sourceProviderOrganizationId: null,
  });
  return {
    async captureRequest(): Promise<void> {
      if (serviceId !== 'happier.agent.claude/claude-subscription') return;
      // Clear before the read: failed reads must never reuse the preceding request's identity.
      issued = unknownIdentity();
      try {
        if (!input.nativeHome) return;
        const files = await input.nativeHome.readFiles(['.claude.json', CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME]);
        const parse = (fileId: string): unknown => files[fileId] ? JSON.parse(new TextDecoder().decode(files[fileId])) : null;
        const native = readClaudeNativeAccountIdentity(parse('.claude.json'));
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

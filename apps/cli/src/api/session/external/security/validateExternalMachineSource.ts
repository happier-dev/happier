import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveExternalSessionSourceSurface } from '@/session/actions/externalSessions/providerOpsResolution';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
  admitCallerChosenExternalSessionSourceFields,
  admitCallerChosenExternalSessionSourceFieldsOnRequestedValue,
} from './admitCallerChosenExternalSessionSourceFields';

const EMPTY_TRANSCRIPT_MEDIA_READ_ROOTS: readonly string[] = Object.freeze([]);

function refuseCallerChosenSourceField(field: string): never {
  throw new ExternalSessionProviderFailureError({
    code: 'source_invalid',
    operation: 'resolveSource',
    retryable: false,
    message:
      `External-session source field '${field}' must match the configured source; `
      + 'a request cannot name a source the machine environment and account settings did not.',
  });
}

type ExternalMachineSourceValidationFailure = Readonly<{
  ok: false;
  error: string;
  errorCode?: 'invalid_request' | 'agent_unavailable';
}>;

type ValidatedExternalMachineSourceResult =
  | Readonly<{
      ok: true;
      source: ExternalSessionsSource;
      providerOps: Extract<
        Awaited<ReturnType<typeof resolveExternalSessionSourceSurface>>,
        { ok: true }
      >['providerOps'];
      currentAgent: Extract<
        Awaited<ReturnType<typeof resolveExternalSessionSourceSurface>>,
        { ok: true }
      >['currentAgent'];
      agentRuntimeGeneration: Extract<
        Awaited<ReturnType<typeof resolveExternalSessionSourceSurface>>,
        { ok: true }
      >['agentRuntimeGeneration'];
      transcriptMediaReadRoots: readonly string[];
      sourceKeyOwner: Extract<
        Awaited<ReturnType<typeof resolveExternalSessionSourceSurface>>,
        { ok: true }
      >['sourceKeyOwner'];
    }>
  | ExternalMachineSourceValidationFailure;

export async function validateExternalMachineSource(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  source: ExternalSessionsSource;
  env: NodeJS.ProcessEnv;
}>): Promise<ValidatedExternalMachineSourceResult> {
  const { agentId, source, env } = params;
  const resolved = await resolveExternalSessionSourceSurface(agentId, source);
  if (!resolved.ok) {
    return {
      ok: false,
      errorCode: resolved.code === 'agent_unavailable' ? 'agent_unavailable' : 'invalid_request',
      error: `external_session_${resolved.code}`,
    };
  }
  const validateSource = resolved.providerOps.validateSource;
  if (!validateSource) {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    };
  }
  // Handing the source to the Agent leaf is not free: the daemon supervises the
  // attach service the source names, so a caller-named address is health-probed
  // by `validateSource`. The half of the admission rule the request's own value
  // already decides therefore runs first, so a source the materialization does
  // not govern at all is refused before anything dials it.
  const ungoverned = admitCallerChosenExternalSessionSourceFieldsOnRequestedValue({
    declaration: resolved.declaration,
    requestedSource: resolved.source,
    agentSettings: getActiveAccountSettingsSnapshot()?.settings,
    activeServerId: configuration.activeServerId,
  });
  if (!ungoverned.ok) refuseCallerChosenSourceField(ungoverned.field);
  const validated = await validateSource({ source: resolved.source, env });
  if (!validated.ok) return validated;
  const admission = await admitCallerChosenExternalSessionSourceFields({
    declaration: resolved.declaration,
    requestedSource: resolved.source,
    canonicalSource: validated.source,
    agentSettings: getActiveAccountSettingsSnapshot()?.settings,
    activeServerId: configuration.activeServerId,
    canonicalize: async (candidate) => {
      const authorized = await validateSource({ source: candidate, env });
      return authorized.ok ? authorized.source : null;
    },
  });
  if (!admission.ok) refuseCallerChosenSourceField(admission.field);
  const sourceKey = resolved.sourceKeyOwner.resolveSourceKey(validated.source);
  if (!sourceKey) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'external_session_source_invalid',
    };
  }
  const sourceKeyOwner = sourceKey === resolved.sourceKeyOwner.sourceKey
    ? resolved.sourceKeyOwner
    : Object.freeze({
        ...resolved.sourceKeyOwner,
        sourceKey,
      });
  return Object.freeze({
    ok: true,
    source: validated.source,
    providerOps: resolved.providerOps,
    currentAgent: resolved.currentAgent,
    agentRuntimeGeneration: resolved.agentRuntimeGeneration,
    transcriptMediaReadRoots:
      validated.transcriptMediaReadRoots ?? EMPTY_TRANSCRIPT_MEDIA_READ_ROOTS,
    sourceKeyOwner,
  });
}

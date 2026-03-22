import {
  SessionHandoffProviderBundleSchema,
  SessionHandoffTransferredPayloadSchema,
  type SessionHandoffTransferredPayload,
} from '@happier-dev/protocol';

import {
  parseScmSourceControllerWorkspaceExportArtifactsWirePayload,
  type ScmSourceControllerWorkspaceExportArtifacts,
} from '../../../scm/sourceController/workspaceExportArtifacts';

import type { SessionHandoffProviderBundle } from '../types';

export type SessionHandoffTransferredBundlesCompatibilityPayload = Readonly<{
  providerBundle?: SessionHandoffProviderBundle;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>;

function parseTransferredProviderBundleCompatibilityPayload(
  providerBundle: SessionHandoffProviderBundle,
): SessionHandoffProviderBundle {
  const parsed = SessionHandoffProviderBundleSchema.safeParse(providerBundle);
  if (!parsed.success) {
    throw new Error('Invalid session handoff transfer payload');
  }
  return parsed.data;
}

function hasLegacyTransferredProviderBundleCompatibilityField(
  providerBundle: SessionHandoffProviderBundle,
): boolean {
  if (providerBundle.providerId !== 'codex') {
    return false;
  }
  return 'codexBackendMode' in (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown })
    && (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown }).codexBackendMode !== undefined;
}

function assertCanonicalTransferredBundlesInput(
  payload: SessionHandoffTransferredBundlesCompatibilityPayload,
): void {
  if (payload.providerBundle && hasLegacyTransferredProviderBundleCompatibilityField(payload.providerBundle)) {
    throw new Error('Invalid session handoff transfer payload');
  }
}

function createSessionHandoffTransferredBundlesCompatibilityPayload(input: Readonly<{
  providerBundle?: SessionHandoffProviderBundle;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>): SessionHandoffTransferredBundlesCompatibilityPayload {
  assertCanonicalTransferredBundlesInput(input);
  return {
    ...(input.providerBundle
      ? { providerBundle: parseTransferredProviderBundleCompatibilityPayload(input.providerBundle) }
      : {}),
    ...(input.workspaceExportArtifacts ? { workspaceExportArtifacts: input.workspaceExportArtifacts } : {}),
  };
}

function decodeCanonicalSessionHandoffTransferredPayloadCompatibilityPayload(
  payload: SessionHandoffTransferredPayload,
): SessionHandoffTransferredBundlesCompatibilityPayload {
  const workspaceExportArtifacts = payload.workspaceArtifacts === undefined
    ? null
    : parseScmSourceControllerWorkspaceExportArtifactsWirePayload(payload.workspaceArtifacts);
  return createSessionHandoffTransferredBundlesCompatibilityPayload({
    ...(payload.providerBundle ? { providerBundle: payload.providerBundle } : {}),
    ...(workspaceExportArtifacts ? { workspaceExportArtifacts } : {}),
  });
}

function parseSessionHandoffTransferredCompatibilityPayload(
  payload: unknown,
): SessionHandoffTransferredBundlesCompatibilityPayload {
  const parsed = SessionHandoffTransferredPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid session handoff transfer payload');
  }
  return decodeCanonicalSessionHandoffTransferredPayloadCompatibilityPayload(parsed.data);
}

export function parseSessionHandoffTransferredCompatibilityPayloadBuffer(
  payload: Buffer,
): SessionHandoffTransferredBundlesCompatibilityPayload {
  try {
    return parseSessionHandoffTransferredCompatibilityPayload(JSON.parse(payload.toString('utf8')));
  } catch {
    throw new Error('Invalid session handoff transfer payload');
  }
}

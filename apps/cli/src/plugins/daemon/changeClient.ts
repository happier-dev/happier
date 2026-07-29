import { randomUUID } from 'node:crypto';

import { decideDaemonPluginChange, requestDaemonPluginChange } from '@/daemon/controlClient';
import { ensureDaemonRunningForSessionCommand } from '@/daemon/ensureDaemon';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';

import type {
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
  PluginResourceSelection,
} from './changeContract';

export type UserPluginChangeResult = PluginChangeRequestResult | PluginChangeDecisionResult;

type PluginChangeConfirmation = (
  message: string,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<boolean>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function waitForDaemonStartup(
  ensureDaemon: () => Promise<void>,
  signal?: AbortSignal,
): Promise<'ready' | 'aborted'> {
  if (!signal) {
    await ensureDaemon();
    return 'ready';
  }
  if (signal.aborted) return 'aborted';

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => resolve('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void ensureDaemon().then(
      () => finish(() => resolve('ready')),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function requestConfirmation(
  confirm: PluginChangeConfirmation,
  message: string,
  signal?: AbortSignal,
): Promise<Readonly<{ kind: 'answered'; approved: boolean }> | Readonly<{ kind: 'aborted' }>> {
  if (!signal) {
    try {
      return { kind: 'answered', approved: await confirm(message) };
    } catch (error) {
      if (isAbortError(error)) return { kind: 'aborted' };
      throw error;
    }
  }
  if (signal.aborted) return { kind: 'aborted' };

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      settle: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => resolve({ kind: 'aborted' }));
    signal.addEventListener('abort', onAbort, { once: true });
    void confirm(message, { signal }).then(
      (approved) => finish(() => resolve({ kind: 'answered', approved })),
      (error: unknown) => {
        if (signal.aborted || isAbortError(error)) {
          finish(() => resolve({ kind: 'aborted' }));
          return;
        }
        finish(() => reject(error));
      },
    );
    if (signal.aborted) onAbort();
  });
}

function isAmbiguousDaemonTransportLoss(
  result: PluginChangeRequestResult | PluginChangeDecisionResult,
): boolean {
  return result.kind === 'unavailable' && result.code === 'daemon_unavailable';
}

function formatPublisher(
  publisher: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['publisherIdentity'],
): string {
  return publisher.status === 'unavailable'
    ? 'Unavailable'
    : `${publisher.displayName} (${publisher.id}; marketplace claim, not signature-verified)`;
}

function formatSignature(
  signature: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['signature'],
): string {
  if (signature.status === 'notProvided') return 'Not provided';
  return signature.status === 'verified'
    ? `Registry signature verified (${signature.keyId})`
    : `Registry signature uses an unsupported key (${signature.keyId})`;
}

function formatProvenance(
  provenance: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['provenance'],
): string {
  switch (provenance.status) {
    case 'notProvided': return 'Not provided';
    case 'declaredUnverified': return `Declared, not verified (${provenance.predicateType})`;
    case 'retrievedUnverified': return `Retrieved, not verified (${provenance.predicateTypes.join(', ')})`;
    case 'unavailable': return `Unavailable (${provenance.code})`;
  }
}

function formatCuration(
  curation: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['curation'],
): string {
  switch (curation.status) {
    case 'notApplicable': return 'Not a marketplace-curated install';
    case 'unreviewed': return `Unreviewed marketplace listing (${curation.sourceId})`;
    case 'approved': return `Approved marketplace listing (${curation.sourceId}, ${curation.reviewedAt})${
      curation.reason ? ` — ${curation.reason}` : ''
    }`;
  }
}

function formatUpdateChannel(
  channel: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['updateChannel'],
): string {
  if (channel.kind === 'path') {
    return `${channel.development ? 'Development path' : 'Path'}: ${channel.locator}`;
  }
  if (channel.kind === 'archive') return `Archive: ${channel.locator}`;
  const registryProfile = channel.registryProfileId
    ? ` via registry profile ${channel.registryProfileId}`
    : '';
  const marketplace = channel.marketplaceSource
    ? ` via ${channel.marketplaceSource.kind} source ${channel.marketplaceSource.id}`
    : '';
  return `npm: ${channel.packageName} at ${channel.registryOrigin}${registryProfile}${marketplace}`;
}

export function formatPluginInstallationReviewForTerminal(
  review: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review'],
): string {
  const accessLines = (
    label: string,
    access: typeof review.requiredHostAccess,
  ): readonly string[] => [
    `${label}:`,
    ...(access.length > 0
      ? access.map((entry) => (
          `- ${entry.id}: ${entry.capability} [${entry.authorizationClass}] — ${entry.reason}; `
          + `scope ${JSON.stringify(entry.normalizedScope)}`
        ))
      : ['- None']),
  ];
  const contributions = review.contributions.length > 0
    ? review.contributions.map((entry) => `${entry.family} (${entry.count})`).join(', ')
    : 'None';
  const uiArtifacts = review.uiArtifacts.contributionIds.length > 0
    ? `${review.uiArtifacts.status}: ${review.uiArtifacts.contributionIds.join(', ')}`
    : 'None';
  return [
    `Install & Trust ${review.displayName} ${review.version}?`,
    'Identity:',
    `- Plugin: ${review.pluginId}`,
    `- Package: ${review.packageIdentity.name ?? 'Unavailable'} ${review.packageIdentity.version}`,
    `- Publisher: ${formatPublisher(review.publisherIdentity)}`,
    `Source: ${review.source.locator}`,
    `Update channel: ${formatUpdateChannel(review.updateChannel)}`,
    'Verification signals:',
    `- Source integrity: ${review.source.integrity ? 'Provided and matched staged bytes' : 'Not provided'}`,
    '- Package, manifest, and UI artifact digests: verified against the staged candidate',
    `- Signature: ${formatSignature(review.signature)}`,
    `- Provenance: ${formatProvenance(review.provenance)}`,
    `- Curation: ${formatCuration(review.curation)}`,
    `Executable realms: ${review.executableRealms.length > 0 ? review.executableRealms.join(', ') : 'None'}`,
    `Contributions: ${contributions}`,
    `UI artifacts: ${uiArtifacts}`,
    'Trust boundary: daemon and React Native code runs with the current app or process authority and can directly use files, network, environment, and processes.',
    'The host access listed below describes Happier-mediated services. It is not a sandbox for executable plugin code.',
    ...accessLines('Required disclosures and cooperative services', review.requiredHostAccess),
    ...accessLines('Optional host-owned resources (off by default)', review.optionalHostAccess),
    'Compatibility and updates:',
    `- Happier: ${review.compatibility.happier}`,
    `- Plugin runtime API: ${review.compatibility.runtimeApiVersion}`,
    `- Update policy: ${review.updatePolicy}`,
  ].join('\n');
}

export async function requestUserPluginChange(
  input: Readonly<{
    request: PluginChangeRequest;
    approval: 'prompt' | 'none';
    signal?: AbortSignal;
  }>,
  dependencies: Readonly<{
    ensureDaemon?: () => Promise<void>;
    confirm?: PluginChangeConfirmation;
    requestChange?: (
      request: PluginChangeRequest,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeRequestResult>;
    decideChange?: (
      decision: PluginChangeDecision,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeDecisionResult>;
    createInteractionId?: () => string;
    nowMs?: () => number;
  }> = {},
): Promise<UserPluginChangeResult> {
  try {
    const startup = await waitForDaemonStartup(
      dependencies.ensureDaemon ?? ensureDaemonRunningForSessionCommand,
      input.signal,
    );
    if (startup === 'aborted' || input.signal?.aborted) return { kind: 'cancelled' };
  } catch {
    return { kind: 'unavailable', code: 'daemon_unavailable' };
  }
  const request = input.request;
  const requestChange = dependencies.requestChange ?? requestDaemonPluginChange;
  const result = input.signal
    ? await requestChange(request, { signal: input.signal })
    : await requestChange(request);
  const possiblyCommittedPluginId = 'pluginId' in request
    ? request.pluginId
    : request.kind === 'installNpm'
      ? request.expectedMarketplaceListing?.pluginId
      : undefined;
  if (isAmbiguousDaemonTransportLoss(result) && possiblyCommittedPluginId) {
    return { kind: 'outcomeUnknown', pluginId: possiblyCommittedPluginId };
  }
  if (result.kind !== 'reviewRequired' || input.approval === 'none') return result;

  const confirm = dependencies.confirm ?? ((
    message: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => promptConfirmYesNo(message, {
    default: 'no',
    ...(options?.signal ? { signal: options.signal } : {}),
  }));
  const decideChange = dependencies.decideChange ?? decideDaemonPluginChange;
  const cancelPendingChange = async (): Promise<PluginChangeDecisionResult> => await decideChange({
    pendingChangeId: result.pendingChangeId,
    decision: 'cancel',
  });
  const packageConfirmation = await requestConfirmation(
    confirm,
    formatPluginInstallationReviewForTerminal(result.review),
    input.signal,
  );
  if (packageConfirmation.kind === 'aborted') return await cancelPendingChange();
  const approved = packageConfirmation.approved;
  let optionalSelections: readonly PluginResourceSelection[] | undefined;
  if (approved) {
    const selections: PluginResourceSelection[] = [];
    for (const request of result.review.optionalHostAccess) {
      const optionalConfirmation = await requestConfirmation(
        confirm,
        `Allow optional ${request.capability} access: ${request.reason}?`,
        input.signal,
      );
      if (optionalConfirmation.kind === 'aborted') return await cancelPendingChange();
      selections.push({
        accessId: request.id,
        selected: optionalConfirmation.approved,
      });
    }
    optionalSelections = selections;
  }
  const decision = (approved
    ? {
        pendingChangeId: result.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: (dependencies.createInteractionId ?? randomUUID)(),
          occurredAtMs: (dependencies.nowMs ?? Date.now)(),
        },
        optionalSelections,
      }
    : {
        pendingChangeId: result.pendingChangeId,
        decision: 'cancel',
      }) satisfies PluginChangeDecision;
  const decisionResult = decision.decision === 'cancel'
    ? await decideChange(decision)
    : input.signal
      ? await decideChange(decision, { signal: input.signal })
      : await decideChange(decision);
  if (approved && isAmbiguousDaemonTransportLoss(decisionResult)) {
    return { kind: 'outcomeUnknown', pluginId: result.review.pluginId };
  }
  return decisionResult;
}

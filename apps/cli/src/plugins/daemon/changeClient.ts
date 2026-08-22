import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import {
  decideDaemonPluginChange,
  listDaemonPluginChanges,
  readDaemonPluginChangeStatus,
  requestDaemonPluginChange,
} from '@/daemon/controlClient';
import { ensureDaemonRunningForSessionCommand } from '@/daemon/ensureDaemon';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';

import type {
  AuthenticatedUserInteraction,
  PluginChangeActorProvenance,
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangeListResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
  PluginChangeStatusResult,
  PluginResourceSelection,
} from './changeContract';

export type UserPluginChangeResult = PluginChangeRequestResult | PluginChangeDecisionResult;

export type UserPluginChangeStatusResult = PluginChangeStatusResult;

export type UserPluginChangeListResult = PluginChangeListResult;

export type UserPluginChangeApproval = 'prompt' | 'none' | 'explicitNonInteractiveTrust';

type UserPluginChangeApprovalInput = Readonly<{
  interactive: boolean;
  json?: boolean;
  explicitTrust?: boolean;
}>;

/**
 * Keeps every CLI entry point on one approval-mode decision while the daemon
 * remains the owner of the pending review and trust transition itself.
 */
export function resolveUserPluginChangeApproval(
  input: UserPluginChangeApprovalInput & Readonly<{ explicitTrust: true }>,
): 'explicitNonInteractiveTrust';
export function resolveUserPluginChangeApproval(
  input: UserPluginChangeApprovalInput & Readonly<{ explicitTrust?: false | undefined }>,
): 'prompt' | 'none';
export function resolveUserPluginChangeApproval(
  input: UserPluginChangeApprovalInput,
): UserPluginChangeApproval;
export function resolveUserPluginChangeApproval(
  input: UserPluginChangeApprovalInput,
): UserPluginChangeApproval {
  if (input.explicitTrust) return 'explicitNonInteractiveTrust';
  return input.json || !input.interactive ? 'none' : 'prompt';
}

/**
 * The explicit CLI decision vocabulary. It intentionally does not expose the
 * daemon's trust decision names to callers: the daemon-issued pending review
 * remains the authority for which present-user decision is currently valid.
 */
export type UserPluginChangeDecision = 'approve' | 'reject';

export type UserPluginChangeDecisionResult = PluginChangeDecisionResult | UserPluginChangeStatusResult;

type PluginChangeConfirmation = (
  message: string,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<boolean>;

type ExplicitNonInteractiveTrustTarget = Readonly<{
  kind: 'path';
  locator: string;
}>;

type ExplicitNonInteractiveTrustAuthorization = Readonly<{
  interactionId: string;
  occurredAtMs: number;
}>;

type LocalDevelopmentPluginInstallRequest = Readonly<{
  kind: 'installPath';
  locator: string;
  development: true;
  sdkRegistryOrigin?: string;
}>;

function isExplicitNonInteractiveTrustRequest(
  request: PluginChangeRequest,
): request is LocalDevelopmentPluginInstallRequest {
  return request.kind === 'installPath' && request.development;
}

async function resolveExplicitNonInteractiveTrustTarget(
  request: PluginChangeRequest,
): Promise<ExplicitNonInteractiveTrustTarget | null> {
  if (!isExplicitNonInteractiveTrustRequest(request)) return null;
  try {
    const source = await resolveLocalPathPluginSource({ locator: request.locator });
    if (source.ok) {
      return { kind: 'path', locator: source.sourceSpec.locator };
    }
  } catch {
    // Fall through to the raw canonical path. The daemon retains source
    // validation authority and returns its own typed source diagnostics.
  }
  try {
    return { kind: 'path', locator: await realpath(request.locator) };
  } catch {
    // The daemon remains the authority for source validity. Retaining the
    // client-resolved locator lets its typed validation report a missing path.
    return { kind: 'path', locator: request.locator };
  }
}

function reviewNamesExactExplicitNonInteractiveTrustSource(
  review: Readonly<{ source: Readonly<{ kind: string; locator: string }> }>,
  target: ExplicitNonInteractiveTrustTarget,
): boolean {
  return review.source.kind === target.kind && review.source.locator === target.locator;
}

function reviewIsExactExplicitNonInteractiveTrustInstall(
  review: Extract<PluginChangeRequestResult, Readonly<{ kind: 'reviewRequired' }>>['review'],
  target: ExplicitNonInteractiveTrustTarget,
): boolean {
  return reviewNamesExactExplicitNonInteractiveTrustSource(review, target)
    && review.updateChannel.kind === 'path'
    && review.updateChannel.development
    && review.updateChannel.locator === target.locator;
}

function createExplicitNonInteractiveTrustActorEvidence(
  authorization: ExplicitNonInteractiveTrustAuthorization,
  target: ExplicitNonInteractiveTrustTarget,
  pluginId?: string,
): AuthenticatedUserInteraction {
  const provenance: PluginChangeActorProvenance = {
    kind: 'explicitCliTrustFlag',
    command: 'plugins install',
    flag: '--trust',
    source: target,
    ...(pluginId === undefined ? {} : { pluginId }),
  };
  return {
    kind: 'authenticatedLocalUser',
    ...authorization,
    provenance,
  };
}

async function cancelMismatchedExplicitNonInteractiveTrustReview(
  pendingChangeId: string,
  decideChange: (decision: PluginChangeDecision) => Promise<PluginChangeDecisionResult>,
): Promise<Extract<PluginChangeDecisionResult, Readonly<{ kind: 'failed' }>>> {
  try {
    await decideChange({ pendingChangeId, decision: 'cancel' });
  } catch {
    // A cancellation transport loss cannot become approval. The daemon will
    // expire the unapproved candidate under its existing pending lifecycle.
  }
  return {
    kind: 'failed',
    code: 'plugin_explicit_trust_target_mismatch',
    message: 'The daemon review did not match the exact local development source requested with --trust.',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The daemon resolves a relative plugin source path against its own working
 * directory, which is never the directory the author typed the command in.
 * Every local path a user can supply is therefore made absolute here, in the
 * client that owns that working directory, before the request is sent. A blank
 * locator stays verbatim so the daemon request schema still rejects it instead
 * of silently becoming the caller's working directory.
 */
export function resolvePluginChangeRequestClientPaths(
  request: PluginChangeRequest,
): PluginChangeRequest {
  if (request.kind === 'installPath') {
    return {
      ...request,
      locator: resolveAbsolutePathFromWorkingDirectory(request.locator) ?? request.locator,
    };
  }
  if (request.kind === 'development') {
    return {
      ...request,
      sourceRootPath: resolveAbsolutePathFromWorkingDirectory(request.sourceRootPath)
        ?? request.sourceRootPath,
    };
  }
  return request;
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

/**
 * Rejoins the existing daemon-owned change by its issued id. This deliberately
 * does not call the request or decision paths, so reconnecting cannot create a
 * second candidate or fabricate present-user approval evidence.
 */
export async function readUserPluginChangeStatus(
  input: Readonly<{
    pendingChangeId: string;
    signal?: AbortSignal;
  }>,
  dependencies: Readonly<{
    ensureDaemon?: () => Promise<void>;
    readStatus?: (
      request: Readonly<{ pendingChangeId: string }>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeStatusResult>;
  }> = {},
): Promise<UserPluginChangeStatusResult> {
  const pendingChangeId = input.pendingChangeId.trim();
  if (!pendingChangeId) return { kind: 'expired' };
  try {
    const startup = await waitForDaemonStartup(
      dependencies.ensureDaemon ?? ensureDaemonRunningForSessionCommand,
      input.signal,
    );
    if (startup === 'aborted' || input.signal?.aborted) return { kind: 'daemonUnavailable' };
  } catch {
    return { kind: 'daemonUnavailable' };
  }
  const readStatus = dependencies.readStatus ?? readDaemonPluginChangeStatus;
  return input.signal
    ? await readStatus({ pendingChangeId }, { signal: input.signal })
    : await readStatus({ pendingChangeId });
}

/**
 * Lists the daemon's outstanding plugin-change decisions.
 *
 * This is the discovery half of the rejoin pair: {@link readUserPluginChangeStatus}
 * needs an id the caller already holds, which a client that did not start the
 * change never has. An Agent may prepare a change, but only a present user can
 * decide it, so the decision has to be findable from the app without the Agent
 * handing an id over out of band.
 *
 * Unlike the by-id read it deliberately does NOT start the daemon. Pending
 * changes are in-memory and daemon-lifetime, so a stopped daemon holds none;
 * starting one to prove that would be a side effect of merely looking.
 */
export async function listUserPluginChanges(
  input: Readonly<{ signal?: AbortSignal }> = {},
  dependencies: Readonly<{
    listChanges?: (
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeListResult>;
  }> = {},
): Promise<UserPluginChangeListResult> {
  if (input.signal?.aborted) return { changes: [] };
  const listChanges = dependencies.listChanges ?? listDaemonPluginChanges;
  return input.signal ? await listChanges({ signal: input.signal }) : await listChanges();
}

/**
 * Decides a daemon-owned pending plugin change by its opaque id. Callers do
 * not choose a daemon trust operation or supply review facts: the current
 * pending review determines whether approval trusts a source root or performs
 * Install & Trust. An explicit rejection never fabricates user evidence.
 */
export async function decideUserPluginChange(
  input: Readonly<{
    pendingChangeId: string;
    decision: UserPluginChangeDecision;
    signal?: AbortSignal;
  }>,
  dependencies: Readonly<{
    ensureDaemon?: () => Promise<void>;
    readStatus?: (
      request: Readonly<{ pendingChangeId: string }>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeStatusResult>;
    decideChange?: (
      decision: PluginChangeDecision,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginChangeDecisionResult>;
    createInteractionId?: () => string;
    nowMs?: () => number;
  }> = {},
): Promise<UserPluginChangeDecisionResult> {
  const pendingChangeId = input.pendingChangeId.trim();
  if (!pendingChangeId) return { kind: 'expired' };
  try {
    const startup = await waitForDaemonStartup(
      dependencies.ensureDaemon ?? ensureDaemonRunningForSessionCommand,
      input.signal,
    );
    if (startup === 'aborted' || input.signal?.aborted) return { kind: 'daemonUnavailable' };
  } catch {
    return { kind: 'daemonUnavailable' };
  }

  const readStatus = dependencies.readStatus ?? readDaemonPluginChangeStatus;
  const status = input.signal
    ? await readStatus({ pendingChangeId }, { signal: input.signal })
    : await readStatus({ pendingChangeId });
  if (status.kind !== 'sourceRootReviewRequired' && status.kind !== 'reviewRequired') {
    return status;
  }

  const decision: PluginChangeDecision = input.decision === 'reject'
    ? { pendingChangeId, decision: 'cancel' }
    : status.kind === 'sourceRootReviewRequired'
      ? {
          pendingChangeId,
          decision: 'trustSourceRoot',
          actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: (dependencies.createInteractionId ?? randomUUID)(),
            occurredAtMs: (dependencies.nowMs ?? Date.now)(),
          },
        }
      : {
          pendingChangeId,
          decision: 'installAndTrust',
          actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: (dependencies.createInteractionId ?? randomUUID)(),
            occurredAtMs: (dependencies.nowMs ?? Date.now)(),
          },
          // A noninteractive explicit decision never widens the review by
          // selecting optional host-owned resources. The interactive review
          // path remains the owner of optional-resource selection.
          optionalSelections: [],
        };
  const decideChange = dependencies.decideChange ?? decideDaemonPluginChange;
  return decision.decision === 'cancel'
    ? await decideChange(decision)
    : input.signal
      ? await decideChange(decision, { signal: input.signal })
      : await decideChange(decision);
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

function formatRawCredentialSourceClass(
  sourceClass: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['rawCredentialAccess'][number]['sourceClass'],
): string {
  return sourceClass.kind === 'savedSecret'
    ? `savedSecret(${sourceClass.secretKinds.join(', ')})`
    : `connectedAccount(${sourceClass.service.pluginId}/${sourceClass.service.localId})`;
}

function formatRawCredentialAccess(
  access: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['rawCredentialAccess'][number],
): readonly string[] {
  return [
    `- ${access.contribution.pluginId}/${access.contribution.localId} · ${access.credentialSlot.title} `
      + `(${access.credentialSlot.id}; ${access.credentialSlot.purpose})`,
    `  Source: ${formatRawCredentialSourceClass(access.sourceClass)}; phase: ${access.phase}; `
      + `access: ${access.accessMode}; request ${JSON.stringify(access.request)}`,
    `  Plugin code in the ${access.realm} realm receives the selected credential directly and can use or copy it.`,
  ];
}

function formatRequestInterceptorPolicy(
  policy: Extract<PluginChangeRequestResult, { kind: 'reviewRequired' }>['review']['requestInterceptors'][number],
): string {
  return `- ${policy.id}: origins ${policy.origins.join(', ')}; methods ${
    policy.methods === undefined ? 'all HTTP methods' : policy.methods.join(', ')
  }; priority ${policy.priority}`;
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
  const blockedNewerVersions = review.compatibility.blockedNewerVersions ?? [];
  const rawCredentialAccess = review.rawCredentialAccess;
  const requestInterceptors = review.requestInterceptors;
  return [
    `Install & Trust ${review.displayName} ${review.version}?`,
    'Identity:',
    `- Plugin: ${review.pluginId}`,
    `- Package: ${review.packageIdentity.name ?? 'Unavailable'} ${review.packageIdentity.version}`,
    `- Publisher: ${formatPublisher(review.publisherIdentity)}`,
    `Source: ${review.source.locator}`,
    `Update channel: ${formatUpdateChannel(review.updateChannel)}`,
    'Verification signals:',
    `- Source integrity: ${'integrity' in review.source && review.source.integrity
      ? 'Provided and matched staged bytes'
      : 'Not provided'}`,
    '- Manifest, contributions, and UI artifact declarations: validated in the staged candidate',
    `- Signature: ${formatSignature(review.signature)}`,
    `- Provenance: ${formatProvenance(review.provenance)}`,
    `- Curation: ${formatCuration(review.curation)}`,
    `Executable realms: ${review.executableRealms.length > 0 ? review.executableRealms.join(', ') : 'None'}`,
    `Contributions: ${contributions}`,
    ...(requestInterceptors.length > 0
      ? [
          'Request interceptor policies:',
          ...requestInterceptors.map(formatRequestInterceptorPolicy),
        ]
      : []),
    `UI artifacts: ${uiArtifacts}`,
    'Trust boundary: daemon and React Native code runs with the current app or process authority and can directly use files, network, environment, and processes.',
    'The host access listed below describes Happier-mediated services. It is not a sandbox for executable plugin code.',
    ...accessLines('Required disclosures and cooperative services', review.requiredHostAccess),
    ...accessLines('Optional host-owned resources (off by default)', review.optionalHostAccess),
    ...(rawCredentialAccess.length > 0
      ? [
          'Raw Voice credential access:',
          ...rawCredentialAccess.flatMap(formatRawCredentialAccess),
        ]
      : []),
    'Compatibility and updates:',
    `- Happier: ${review.compatibility.happier ?? 'Not provided'}`,
    `- Plugin runtime API: ${review.compatibility.runtimeApiVersion}`,
    ...(blockedNewerVersions.length > 0
      ? [
          '- Newer versions blocked before download:',
          ...blockedNewerVersions.map((blocked) => (
            `  - ${blocked.version} ${blocked.diagnostics
              .map((diagnostic) => `[${diagnostic.code}]: ${diagnostic.message}`)
              .join('; ')}`
          )),
        ]
      : []),
    `- Update policy: ${review.updatePolicy}`,
  ].join('\n');
}

export async function requestUserPluginChange(
  input: Readonly<{
    request: PluginChangeRequest;
    approval: UserPluginChangeApproval;
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
  const request = resolvePluginChangeRequestClientPaths(input.request);
  const explicitTrustTarget = input.approval === 'explicitNonInteractiveTrust'
    ? await resolveExplicitNonInteractiveTrustTarget(request)
    : null;
  if (input.approval === 'explicitNonInteractiveTrust' && !explicitTrustTarget) {
    return {
      kind: 'failed',
      code: 'plugin_explicit_trust_requires_development_path',
      message: '--trust is only valid for a local plugin install with --dev.',
    };
  }
  try {
    const startup = await waitForDaemonStartup(
      dependencies.ensureDaemon ?? ensureDaemonRunningForSessionCommand,
      input.signal,
    );
    if (startup === 'aborted' || input.signal?.aborted) return { kind: 'cancelled' };
  } catch {
    return { kind: 'unavailable', code: 'daemon_unavailable' };
  }
  const requestChange = dependencies.requestChange ?? requestDaemonPluginChange;
  let result: PluginChangeRequestResult | PluginChangeDecisionResult = input.signal
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
  if (input.approval === 'none') return result;

  const decideChange = dependencies.decideChange ?? decideDaemonPluginChange;
  if (input.approval === 'explicitNonInteractiveTrust') {
    const authorization: ExplicitNonInteractiveTrustAuthorization = {
      interactionId: (dependencies.createInteractionId ?? randomUUID)(),
      occurredAtMs: (dependencies.nowMs ?? Date.now)(),
    };
    if (result.kind === 'sourceRootReviewRequired') {
      if (!reviewNamesExactExplicitNonInteractiveTrustSource(result.review, explicitTrustTarget!)) {
        return await cancelMismatchedExplicitNonInteractiveTrustReview(
          result.pendingChangeId,
          decideChange,
        );
      }
      const sourceRootDecision: PluginChangeDecision = {
        pendingChangeId: result.pendingChangeId,
        decision: 'trustSourceRoot',
        actorEvidence: createExplicitNonInteractiveTrustActorEvidence(authorization, explicitTrustTarget!),
      };
      result = input.signal
        ? await decideChange(sourceRootDecision, { signal: input.signal })
        : await decideChange(sourceRootDecision);
    }
    if (result.kind !== 'reviewRequired') return result;
    if (!reviewIsExactExplicitNonInteractiveTrustInstall(result.review, explicitTrustTarget!)) {
      return await cancelMismatchedExplicitNonInteractiveTrustReview(
        result.pendingChangeId,
        decideChange,
      );
    }
    const reviewedResult = result;
    const decision: PluginChangeDecision = {
      pendingChangeId: reviewedResult.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: createExplicitNonInteractiveTrustActorEvidence(
        authorization,
        explicitTrustTarget!,
        reviewedResult.review.pluginId,
      ),
      // An explicit CLI trust flag does not select optional host-owned
      // resources. Those remain available only to the reviewed prompt path.
      optionalSelections: [],
    };
    const decisionResult = input.signal
      ? await decideChange(decision, { signal: input.signal })
      : await decideChange(decision);
    if (isAmbiguousDaemonTransportLoss(decisionResult)) {
      return { kind: 'outcomeUnknown', pluginId: reviewedResult.review.pluginId };
    }
    return decisionResult;
  }

  const confirm = dependencies.confirm ?? ((
    message: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => promptConfirmYesNo(message, {
    default: 'no',
      ...(options?.signal ? { signal: options.signal } : {}),
  }));
  if (result.kind === 'sourceRootReviewRequired') {
    const sourceRootConfirmation = await requestConfirmation(
      confirm,
      [
        'Trust this plugin development source root?',
        `Source: ${result.review.source.locator}`,
        'The daemon will evaluate trusted code from this root to derive the plugin manifest and activation entry.',
      ].join('\n'),
      input.signal,
    );
    if (sourceRootConfirmation.kind === 'aborted' || !sourceRootConfirmation.approved) {
      return await decideChange({
        pendingChangeId: result.pendingChangeId,
        decision: 'cancel',
      });
    }
    const sourceRootDecision: PluginChangeDecision = {
      pendingChangeId: result.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: (dependencies.createInteractionId ?? randomUUID)(),
        occurredAtMs: (dependencies.nowMs ?? Date.now)(),
      },
    };
    result = input.signal
      ? await decideChange(sourceRootDecision, { signal: input.signal })
      : await decideChange(sourceRootDecision);
  }
  if (result.kind !== 'reviewRequired') return result;
  const reviewedResult = result;
  const cancelPendingChange = async (): Promise<PluginChangeDecisionResult> => await decideChange({
    pendingChangeId: reviewedResult.pendingChangeId,
    decision: 'cancel',
  });
  const packageConfirmation = await requestConfirmation(
    confirm,
    formatPluginInstallationReviewForTerminal(reviewedResult.review),
    input.signal,
  );
  if (packageConfirmation.kind === 'aborted') return await cancelPendingChange();
  const approved = packageConfirmation.approved;
  let optionalSelections: readonly PluginResourceSelection[] | undefined;
  if (approved) {
    const selections: PluginResourceSelection[] = [];
    for (const request of reviewedResult.review.optionalHostAccess) {
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
        pendingChangeId: reviewedResult.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: (dependencies.createInteractionId ?? randomUUID)(),
          occurredAtMs: (dependencies.nowMs ?? Date.now)(),
        },
        optionalSelections,
      }
    : {
        pendingChangeId: reviewedResult.pendingChangeId,
        decision: 'cancel',
      }) satisfies PluginChangeDecision;
  const decisionResult = decision.decision === 'cancel'
    ? await decideChange(decision)
    : input.signal
      ? await decideChange(decision, { signal: input.signal })
      : await decideChange(decision);
  if (approved && isAmbiguousDaemonTransportLoss(decisionResult)) {
    return { kind: 'outcomeUnknown', pluginId: reviewedResult.review.pluginId };
  }
  return decisionResult;
}

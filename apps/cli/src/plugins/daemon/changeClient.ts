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
  PluginChangeDecision,
  PluginChangeDecisionResult,
  PluginChangeListResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
  PluginChangeStatusResult,
  PluginResourceSelection,
} from './changeContract';

export type UserPluginChangeResult = PluginChangeRequestResult | PluginChangeDecisionResult;

/** One diagnostic projection for every user-facing daemon change caller. */
export function describeUserPluginChangeFailure(result: Exclude<UserPluginChangeResult, { kind: 'committed' }>): Readonly<{
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}> {
  switch (result.kind) {
    case 'projectTrustAccepted':
      return {
        code: 'project_trust_accepted',
        message: `Plugin project trust was accepted for ${result.projectRoot}.`,
        details: { projectRoot: result.projectRoot },
      };
    case 'reviewRequired':
      return result.reviewKind === 'projectTrust'
        ? {
            code: 'project_trust_review_required',
            message: `Project trust review is required for ${result.review.source.locator}.`,
            details: { pendingChangeId: result.pendingChangeId, review: result.review },
          }
        : {
            code: 'review_required',
            message: `Install and trust review is required for ${result.review.displayName}.`,
            details: { pendingChangeId: result.pendingChangeId, review: result.review },
          };
    case 'registryProfileRequired':
      return {
        code: 'plugin_registry_profile_required',
        message: `Npm registry '${result.registryOrigin}' requires a usable registry profile before installing ${result.packageName}.`,
        details: { registryOrigin: result.registryOrigin, packageName: result.packageName, registryProfileId: result.registryProfileId },
      };
    case 'managedResourcesReviewRequired':
      return {
        code: 'managed_resources_review_required',
        message: `Review retained resources before removing ${result.pluginId}; provider charges may continue.`,
        details: { pluginId: result.pluginId, resources: result.resources },
      };
    case 'cancelled':
      return { code: 'cancelled', message: 'The plugin change was cancelled before it was applied.' };
    case 'expired':
      return { code: 'expired', message: 'The plugin review expired; run the command again to review the current candidate.' };
    case 'busy':
      return { code: 'busy', message: `Another plugin change is already in progress for ${result.pluginId}.`, details: { pluginId: result.pluginId } };
    case 'unavailable':
      return { code: 'unavailable', message: `The daemon plugin-change service is unavailable (${result.code}).`, details: { causeCode: result.code } };
    case 'conflict':
      return { code: 'conflict', message: `Plugin facts changed while applying ${result.pluginId}; review the candidate again.`, details: { pluginId: result.pluginId } };
    case 'failed':
      return {
        code: 'failed',
        message: result.message ?? `The daemon rejected the plugin change (${result.code}).`,
        details: { causeCode: result.code, ...(result.message ? { causeMessage: result.message } : {}) },
      };
    case 'outcomeUnknown':
      return {
        code: 'outcome_unknown',
        message: `The daemon may have applied the change for ${result.pluginId}; inspect installed state before retrying.`,
        details: { pluginId: result.pluginId, ...(result.expectedCandidate ? { expectedCandidate: result.expectedCandidate } : {}) },
      };
    case 'dataRemovalPartial':
      return {
        code: 'plugin_data_removal_partial',
        message: 'Plugin data removal stopped after a partial daemon-owned change. Retrying the same confirmed command is safe.',
        details: { pluginId: result.pluginId, causeCode: result.causeCode, completed: result.completed, pending: result.pending },
      };
  }
}

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

type InstallationReviewResult = Extract<
  PluginChangeRequestResult,
  Readonly<{ kind: 'reviewRequired'; reviewKind: 'installation' }>
>;

type PluginChangeConfirmation = (
  message: string,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<boolean>;

type ExplicitNonInteractiveTrustTarget = Readonly<{
  kind: 'path';
  locator: string;
  development: boolean;
}>;

type ExplicitDevelopmentPathRequest = Extract<
  PluginChangeRequest,
  Readonly<{ kind: 'development' | 'installPath' }>
>;

function isExplicitNonInteractiveTrustRequest(
  request: PluginChangeRequest,
): request is ExplicitDevelopmentPathRequest {
  return request.kind === 'development'
    || request.kind === 'installPath';
}

async function resolveExplicitNonInteractiveTrustTarget(
  request: PluginChangeRequest,
): Promise<ExplicitNonInteractiveTrustTarget | null> {
  if (!isExplicitNonInteractiveTrustRequest(request)) return null;
  const locator = request.kind === 'development'
    ? request.sourceRootPath
    : request.locator;
  try {
    const source = await resolveLocalPathPluginSource({ locator });
    if (source.ok) {
      return {
        kind: 'path',
        locator: source.sourceSpec.locator,
        development: request.kind === 'development',
      };
    }
  } catch {
    // Fall through to the raw canonical path. The daemon retains source
    // validation authority and returns its own typed source diagnostics.
  }
  try {
    return {
      kind: 'path',
      locator: await realpath(locator),
      development: request.kind === 'development',
    };
  } catch {
    // The daemon remains the authority for source validity. Retaining the
    // client-resolved locator lets its typed validation report a missing path.
    return {
      kind: 'path',
      locator,
      development: request.kind === 'development',
    };
  }
}

function reviewNamesExactExplicitNonInteractiveTrustSource(
  review: Readonly<{ source: Readonly<{ kind: string; locator: string }> }>,
  target: ExplicitNonInteractiveTrustTarget,
): boolean {
  return review.source.kind === target.kind && review.source.locator === target.locator;
}

function reviewIsExactExplicitNonInteractiveTrustInstall(
  review: InstallationReviewResult['review'],
  target: ExplicitNonInteractiveTrustTarget,
): boolean {
  return reviewNamesExactExplicitNonInteractiveTrustSource(review, target)
    && review.updateChannel.kind === 'path'
    && review.updateChannel.development === target.development
    && review.updateChannel.locator === target.locator;
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
    message: 'The daemon review did not match the exact local path named by the install command.',
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
 * pending review determines whether approval trusts a project source or grants
 * a disclosed authority expansion. An explicit rejection never fabricates
 * user evidence.
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
  if (status.kind !== 'reviewRequired') {
    return status;
  }

  const decision: PluginChangeDecision = input.decision === 'reject'
    ? { pendingChangeId, decision: 'cancel' }
    : {
        pendingChangeId,
        decision: 'installAndTrust',
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
  publisher: InstallationReviewResult['review']['publisherIdentity'],
): string {
  return publisher.status === 'unavailable'
    ? 'Unavailable'
    : `${publisher.displayName} (${publisher.id}; marketplace claim, not signature-verified)`;
}

function formatSignature(
  signature: InstallationReviewResult['review']['signature'],
): string {
  if (signature.status === 'notProvided') return 'Not provided';
  return signature.status === 'verified'
    ? `Registry signature verified (${signature.keyId})`
    : `Registry signature uses an unsupported key (${signature.keyId})`;
}

function formatProvenance(
  provenance: InstallationReviewResult['review']['provenance'],
): string {
  switch (provenance.status) {
    case 'notProvided': return 'Not provided';
    case 'declaredUnverified': return `Declared, not verified (${provenance.predicateType})`;
    case 'retrievedUnverified': return `Retrieved, not verified (${provenance.predicateTypes.join(', ')})`;
    case 'unavailable': return `Unavailable (${provenance.code})`;
  }
}

function formatCuration(
  curation: InstallationReviewResult['review']['curation'],
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
  channel: InstallationReviewResult['review']['updateChannel'],
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
  sourceClass: InstallationReviewResult['review']['rawCredentialAccess'][number]['sourceClass'],
): string {
  return sourceClass.kind === 'savedSecret'
    ? `savedSecret(${sourceClass.secretKinds.join(', ')})`
    : `connectedAccount(${sourceClass.service.pluginId}/${sourceClass.service.localId})`;
}

function formatRawCredentialAccess(
  access: InstallationReviewResult['review']['rawCredentialAccess'][number],
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
  policy: InstallationReviewResult['review']['requestInterceptors'][number],
): string {
  return `- ${policy.id}: origins ${policy.origins.join(', ')}; methods ${
    policy.methods === undefined ? 'all HTTP methods' : policy.methods.join(', ')
  }; priority ${policy.priority}`;
}

export function formatPluginInstallationReviewForTerminal(
  review: InstallationReviewResult['review'],
  authorityExpansion: InstallationReviewResult['authorityExpansion'] = [],
): string {
  const deltaOnly = authorityExpansion.length > 0;
  const expanded = new Set(authorityExpansion);
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
    deltaOnly
      ? `Allow declared authority update for ${review.displayName} ${review.version}?`
      : `Install & Trust ${review.displayName} ${review.version}?`,
    'Identity:',
    `- Plugin: ${review.pluginId}`,
    `- Package: ${review.packageIdentity.name ?? 'Unavailable'} ${review.packageIdentity.version}`,
    `- Publisher: ${formatPublisher(review.publisherIdentity)}`,
    `Source: ${review.source.locator}`,
    `Update channel: ${formatUpdateChannel(review.updateChannel)}`,
    ...(review.source.kind === 'archive' && /^https?:\/\//u.test(review.source.locator)
      ? ['URL retention: Happier saves the full archive URL on this machine, including any credentials, for future updates. Expired or revoked URLs can make updates fail.']
      : []),
    ...(!deltaOnly ? ['Verification signals:'] : []),
    ...(!deltaOnly ? [`- Source integrity: ${review.source.kind === 'path'
      ? 'None'
      : review.source.integrityBasis === 'expected'
        ? 'Matched expected integrity'
        : 'Observed from staged bytes; not independently verified'}`,
      '- Manifest, contributions, and UI artifact declarations: validated in the staged candidate',
      `- Signature: ${formatSignature(review.signature)}`,
      `- Provenance: ${formatProvenance(review.provenance)}`,
      `- Curation: ${formatCuration(review.curation)}`] : []),
    ...(!deltaOnly
      ? [`Executable realms: ${review.executableRealms.length > 0 ? review.executableRealms.join(', ') : 'None'}`]
      : []),
    ...(!deltaOnly ? [`Contributions: ${contributions}`] : []),
    ...((!deltaOnly || expanded.has('requestInterceptor')) && requestInterceptors.length > 0
      ? [
          'Request interceptor policies:',
          ...requestInterceptors.map(formatRequestInterceptorPolicy),
        ]
      : []),
    ...(!deltaOnly ? [`UI artifacts: ${uiArtifacts}`] : []),
    ...(!deltaOnly ? [
      'Trust boundary: daemon and React Native code runs with the current app or process authority and can directly use files, network, environment, and processes.',
      'The host access listed below describes Happier-mediated services. It is not a sandbox for executable plugin code.',
    ] : []),
    ...(!deltaOnly || expanded.has('requiredHostAccess') || expanded.has('connectedAccountPurpose')
      ? accessLines('Required disclosures and cooperative services', review.requiredHostAccess)
      : []),
    ...(!deltaOnly || expanded.has('selectedOptionalHostAccess')
      ? accessLines('Optional host-owned resources (off by default)', review.optionalHostAccess)
      : []),
    ...((!deltaOnly || expanded.has('rawCredentialAccess')) && rawCredentialAccess.length > 0
      ? [
          'Raw Voice credential access:',
          ...rawCredentialAccess.flatMap(formatRawCredentialAccess),
        ]
      : []),
    ...(!deltaOnly ? [
      'Compatibility and updates:',
      `- Happier: ${review.compatibility.happier ?? 'Not provided'}`,
      `- Plugin runtime API: ${review.compatibility.runtimeApiVersion}`,
    ] : []),
    ...(!deltaOnly && blockedNewerVersions.length > 0
      ? [
          '- Newer versions blocked before download:',
          ...blockedNewerVersions.map((blocked) => (
            `  - ${blocked.version} ${blocked.diagnostics
              .map((diagnostic) => `[${diagnostic.code}]: ${diagnostic.message}`)
              .join('; ')}`
          )),
        ]
      : []),
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
  }> = {},
): Promise<UserPluginChangeResult> {
  const request = resolvePluginChangeRequestClientPaths(input.request);
  const explicitTrustTarget = input.approval === 'explicitNonInteractiveTrust'
    ? await resolveExplicitNonInteractiveTrustTarget(request)
    : null;
  if (input.approval === 'explicitNonInteractiveTrust' && !explicitTrustTarget) {
    return {
      kind: 'failed',
      code: 'plugin_explicit_trust_requires_path',
      message: 'Explicit path trust is only valid for a local plugin path.',
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

  if (result.kind === 'managedResourcesReviewRequired') {
    if (input.approval !== 'prompt') return result;
    if ((request.kind !== 'disable' && request.kind !== 'uninstall' && request.kind !== 'uninstallAndDeleteData')
      || request.pluginId !== result.pluginId) {
      return { kind: 'failed', code: 'plugin_managed_resource_review_target_mismatch' };
    }
    const answer = await requestConfirmation(
      dependencies.confirm ?? promptConfirmYesNo,
      `These retained resources may continue to exist and incur provider charges. Manage or delete them through their resource controls, or accept manual responsibility before ${request.kind}.\n${JSON.stringify(result.resources, null, 2)}\nContinue with manual responsibility?`,
      input.signal,
    );
    if (answer.kind === 'aborted' || !answer.approved) return { kind: 'cancelled' };
    const reviewedRequest: PluginChangeRequest = { ...request, managedResourceDispositions: result.resources.map(resource => ({
      managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
      expectedAllocation: resource.allocation,
      ...(resource.resource !== undefined ? { expectedResource: resource.resource } : {}),
      ...(resource.nativeOperationRef !== undefined ? { expectedNativeOperationRef: resource.nativeOperationRef } : {}),
      ...(resource.recovery !== undefined ? { expectedRecovery: resource.recovery } : {}),
      responsibility: 'manual',
    })) };
    const applied = input.signal
      ? await requestChange(reviewedRequest, { signal: input.signal })
      : await requestChange(reviewedRequest);
    return isAmbiguousDaemonTransportLoss(applied) ? { kind: 'outcomeUnknown', pluginId: request.pluginId } : applied;
  }

  const decideChange = dependencies.decideChange ?? decideDaemonPluginChange;
  if (input.approval === 'explicitNonInteractiveTrust') {
    let settledProjectTrust = false;
    if (result.kind === 'reviewRequired' && result.reviewKind === 'projectTrust') {
      if (!reviewNamesExactExplicitNonInteractiveTrustSource(result.review, explicitTrustTarget!)) {
        return await cancelMismatchedExplicitNonInteractiveTrustReview(
          result.pendingChangeId,
          decideChange,
        );
      }
      const projectTrustDecision: PluginChangeDecision = {
        pendingChangeId: result.pendingChangeId,
        decision: 'installAndTrust',
        optionalSelections: [],
      };
      result = input.signal
        ? await decideChange(projectTrustDecision, { signal: input.signal })
        : await decideChange(projectTrustDecision);
      settledProjectTrust = true;
    }
    if (result.kind !== 'reviewRequired' || result.reviewKind !== 'installation') return result;
    if (
      settledProjectTrust
      && result.reason === 'authorityExpansion'
      && result.authorityExpansion.length > 0
    ) {
      return result;
    }
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
      // An explicit CLI path install does not select optional host-owned
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
  if (result.kind === 'reviewRequired' && result.reviewKind === 'projectTrust') {
    const projectTrustConfirmation = await requestConfirmation(
      confirm,
      [
        'Trust this plugin project source?',
        `Source: ${result.review.source.locator}`,
        'The daemon will evaluate trusted code from this root to derive the plugin manifest and activation entry.',
      ].join('\n'),
      input.signal,
    );
    if (projectTrustConfirmation.kind === 'aborted' || !projectTrustConfirmation.approved) {
      return await decideChange({
        pendingChangeId: result.pendingChangeId,
        decision: 'cancel',
      });
    }
    const projectTrustDecision: PluginChangeDecision = {
      pendingChangeId: result.pendingChangeId,
      decision: 'installAndTrust',
      optionalSelections: [],
    };
    result = input.signal
      ? await decideChange(projectTrustDecision, { signal: input.signal })
      : await decideChange(projectTrustDecision);
    if (
      result.kind !== 'reviewRequired'
      || result.reviewKind !== 'installation'
      || result.reason !== 'authorityExpansion'
      || result.authorityExpansion.length === 0
    ) {
      return result;
    }
  }
  if (result.kind !== 'reviewRequired' || result.reviewKind !== 'installation') return result;
  const reviewedResult = result;
  const cancelPendingChange = async (): Promise<PluginChangeDecisionResult> => await decideChange({
    pendingChangeId: reviewedResult.pendingChangeId,
    decision: 'cancel',
  });
  const packageConfirmation = await requestConfirmation(
    confirm,
    formatPluginInstallationReviewForTerminal(
      reviewedResult.review,
      reviewedResult.authorityExpansion,
    ),
    input.signal,
  );
  if (packageConfirmation.kind === 'aborted') return await cancelPendingChange();
  const approved = packageConfirmation.approved;
  let optionalSelections: readonly PluginResourceSelection[] | undefined;
  if (approved) {
    const selections: PluginResourceSelection[] = [];
    const optionalAccessToReview = reviewedResult.reason === 'authorityExpansion'
      && !reviewedResult.authorityExpansion.includes('selectedOptionalHostAccess')
      ? []
      : reviewedResult.review.optionalHostAccess;
    for (const request of optionalAccessToReview) {
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

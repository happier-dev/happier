import type { CommandContext } from '@/cli/commandRegistry';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { configuration } from '@/configuration';
import { randomUUID } from 'node:crypto';
import {
  createOutputBuilder,
  errorFrame,
  renderHelpPage,
  type HelpPageOptions,
} from '@happier-dev/cli-common/output';
import {
  PERSONAL_HOME_SYSTEM_TASK_KINDS,
  parseRemotePersonalHomeApprovalInput,
} from '@happier-dev/cli-common/systemTasks';
import { isHappierRuntimePathWithinRoot } from '@happier-dev/cli-common/happierRuntime';
import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '@happier-dev/cli-common/happierCloud';
import {
  cleanupPersonalHomeRelocationUpload,
  consumePersonalHomeRelocationUpload,
  PersonalHomeRelocationTransferCleanupError,
  preparePersonalHomeRelocationUpload,
  type PersonalHomeRelocationSourceResult,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { SYSTEM_TASK_PROTOCOL_VERSION, SystemTaskJsonValueSchema } from '@happier-dev/protocol/system/tasks/spec';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import type { SystemTaskEvent, SystemTaskJsonObject, SystemTaskJsonValue, SystemTaskSpec, HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import {
  answerRemoteBackgroundServiceReplacementPrompt,
  answerSshHostTrustPrompt,
  isSshHostTrustPromptKind,
  normalizeTrustedHostKeyFlag,
} from './sshHostTrustPrompt';
import { type CliSystemTasksRunnerAdapter, runSystemTaskToCompletion } from './systemTaskCliRunner';
import { createLocalPersonalHome, reconcileCreatedPersonalHome } from './home/createLocalPersonalHome';
import {
  encodeCliDirectHomeQrTaskStreamEvent,
  runCliDirectHomeQr,
  type CliDirectHomeQrResult,
} from '@/auth/directHomeQr/runCliDirectHomeQr';
import {
  linkCliHomeToAccountService,
  unlinkCliHomeFromAccountService,
  type CliHomeLinkUnavailableReason,
} from '@/auth/accountService/linkCliHomeToAccountService';
import { resolveCliSelectedAccountServicePresentation } from '@/auth/accountService/cliAccountServicePresentation';
import {
  adoptServerProfileHomeConnectionDescriptor,
  getActiveServerProfile,
  getServerProfile,
} from '@/server/serverProfiles';

type PersonalHomePurpose = Readonly<{
  kind: 'personal-home';
  canonicalServerUrl: string;
}>;

type PersonalHomeRelocationRecovery =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'ambiguous' }>
  | Readonly<{
      status: 'recovery_available';
      operationId: string;
      destinationMachineId: string;
      sourceDescriptorRevision: number;
      primaryAction: 'finish_move';
      secondaryAction?: 'return_to_source';
    }>;

export type PersonalHomeCreateResult = Readonly<{
  status: 'complete';
  profileId?: string;
  homeServerIdentityId: string;
  canonicalServerUrl: string;
  accountCreated: boolean;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  descriptor?: HomeConnectionDescriptorV1;
  accountServiceLink: HomePostCreateLinkResult;
  invokingClientEnrollment?: Readonly<{ kind: 'enrolled' | 'failed' | 'not_requested' }>;
  pairing?: HomePairDeviceResult;
}>;

export type HomePairDeviceResult = CliDirectHomeQrResult;
type RemoteHomePairingResult = HomePairDeviceResult | Readonly<{ kind: 'not_requested' }>;

export type HomeLinkAccountResult =
  | Readonly<{ kind: 'linked'; homeServerIdentityId: string }>
  | Readonly<{ kind: 'relink_required'; homeServerIdentityId: string }>
  | Readonly<{ kind: 'unavailable'; reason: CliHomeLinkUnavailableReason; selectedEndpoint?: string }>
  | Readonly<{ kind: 'cancelled' | 'failed' }>;

/** What stopping delegated sign-in for one Home can answer. */
export type HomeUnlinkAccountResult =
  | Readonly<{ kind: 'unlinked'; homeServerIdentityId: string; issuerServerIdentityId: string }>
  | Readonly<{ kind: 'unavailable'; reason: CliHomeLinkUnavailableReason }>
  | Readonly<{ kind: 'cancelled' | 'failed' }>;

export type HomePostCreateLinkResult = HomeLinkAccountResult | Readonly<{
  kind: 'not_requested' | 'unable_to_attempt';
}>;

export type HomeCommandDeps = Readonly<{
  createRunner: (runtime: Readonly<{
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
  }>) => CliSystemTasksRunnerAdapter;
  resolvePath: (value: string) => string | null;
  isInteractiveTerminal: () => boolean;
  promptInput: (prompt: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  resolveDefaultChannel: () => 'stable' | 'preview' | 'dev';
  resolveSelectedAccountServicePresentation?: typeof resolveCliSelectedAccountServicePresentation;
  readApprovalInput?: () => Promise<string>;
  prepareRelocationUpload?: typeof preparePersonalHomeRelocationUpload;
  consumeRelocationUpload?: typeof consumePersonalHomeRelocationUpload;
  cleanupRelocationUpload?: typeof cleanupPersonalHomeRelocationUpload;
  createPersonalHome?: (runtime: Readonly<{
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
  }>, options?: Readonly<{
    allowErasedRuntimeRecreate?: boolean;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    profileId: string;
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    accountCreated: boolean;
    descriptor?: HomeConnectionDescriptorV1;
  }>>;
  reconcileCreatedHome?: (profileId: string, options?: Readonly<{
    quiet: boolean;
    signal?: AbortSignal;
    replaceServices?: boolean;
    switchChannel?: boolean;
  }>) => Promise<void>;
  pairDevice?: (input: Readonly<{
    profileRef?: string;
    copyLink: boolean;
    signal?: AbortSignal;
    onInvite?: (input: Readonly<{ link: string }>) => void;
  }>) => Promise<HomePairDeviceResult>;
  linkAccount?: (input: Readonly<{
    homeServerIdentityId?: string;
    relink: boolean;
    signal?: AbortSignal;
    expectedAccountServiceSelection?: Readonly<{ endpoint: string; serverIdentityId: string }>;
  }>) => Promise<HomeLinkAccountResult>;
  unlinkAccount?: (input: Readonly<{
    homeServerIdentityId?: string;
    signal?: AbortSignal;
  }>) => Promise<HomeUnlinkAccountResult>;
  createRelocationOperationId?: () => string;
  readRelocationSourceProfile?: () => Promise<Readonly<{
    profileId: string;
    name: string;
    descriptor: HomeConnectionDescriptorV1;
  }>>;
  publishRelocationDescriptor?: (input: Readonly<{
    profileId: string;
    descriptor: HomeConnectionDescriptorV1;
  }>) => Promise<HomeConnectionDescriptorV1>;
  readRelocationDescriptor?: (input: Readonly<{
    profileId: string;
    homeServerIdentityId: string;
  }>) => Promise<HomeConnectionDescriptorV1 | null>;
}>;

const DEFAULT_DEPS: HomeCommandDeps = {
  createRunner: (runtime) => {
    const runner = getLiveSystemTasksRunnerAdapter({ personalHomeRuntime: runtime });
    return {
      start: async (params) => await runner.start(params as never) as Readonly<{ taskId: string }>,
      poll: async (params) => await runner.poll(params as never) as Awaited<ReturnType<CliSystemTasksRunnerAdapter['poll']>>,
      respond: async (params) => await runner.respond(params as never),
      cancel: async (params) => await runner.cancel(params as never),
    };
  },
  resolvePath: resolveAbsolutePathFromWorkingDirectory,
  isInteractiveTerminal,
  promptInput,
  sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  resolveDefaultChannel: () => configuration.publicReleaseRing === 'publicdev'
    ? 'dev'
    : configuration.publicReleaseRing,
  resolveSelectedAccountServicePresentation: resolveCliSelectedAccountServicePresentation,
  readApprovalInput: async () => {
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) input += String(chunk);
    return input;
  },
  prepareRelocationUpload: preparePersonalHomeRelocationUpload,
  consumeRelocationUpload: consumePersonalHomeRelocationUpload,
  cleanupRelocationUpload: cleanupPersonalHomeRelocationUpload,
  createPersonalHome: createLocalPersonalHome,
  reconcileCreatedHome: reconcileCreatedPersonalHome,
  pairDevice: runCliDirectHomeQr,
  linkAccount: linkCliHomeToAccountService,
  unlinkAccount: unlinkCliHomeFromAccountService,
  createRelocationOperationId: () => `relocation-${randomUUID()}`,
  readRelocationSourceProfile: async () => {
    const profile = await getActiveServerProfile();
    if (!profile.homeConnectionDescriptor || profile.homeConnectionDescriptorAuthority !== 'exact') {
      throw Object.assign(new Error('The active Home profile has no exact connection descriptor for relocation.'), { code: 'home_profile_unavailable' });
    }
    return { profileId: profile.id, name: profile.name, descriptor: profile.homeConnectionDescriptor };
  },
  publishRelocationDescriptor: async ({ profileId, descriptor }) => {
    const adopted = await adoptServerProfileHomeConnectionDescriptor({
      descriptor,
      expectedProfileId: profileId,
      observation: 'exact',
    });
    const retained = adopted.profile.homeConnectionDescriptor;
    if (!retained) throw new Error('Personal Home relocation descriptor was not retained.');
    return retained;
  },
  readRelocationDescriptor: async ({ profileId, homeServerIdentityId }) => {
    const profile = await getServerProfile(profileId);
    return profile.homeConnectionDescriptor?.homeServerIdentityId === homeServerIdentityId
      ? profile.homeConnectionDescriptor
      : null;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePersonalHomeRelocationResult(value: unknown): PersonalHomeRelocationSourceResult | null {
  if (!isRecord(value)
    || typeof value.operationId !== 'string'
    || typeof value.destinationMachineId !== 'string'
    || !Number.isInteger(value.sourceDescriptorRevision)
    || (value.status !== 'committed' && value.status !== 'pending' && value.status !== 'returned')) {
    return null;
  }
  if (value.status === 'pending'
    && value.recoveryAction !== 'finish_move'
    && value.recoveryAction !== 'return_to_source') {
    return null;
  }
  return value as PersonalHomeRelocationSourceResult;
}

function takeFlag(args: string[], name: string): Readonly<{ present: boolean; rest: string[] }> {
  const rest = args.filter((value) => value !== name);
  return { present: rest.length !== args.length, rest };
}

function takeFlagValue(args: string[], name: string): Readonly<{ value: string | null; rest: string[] }> {
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] ?? '');
    if (current === name) {
      const next = String(args[index + 1] ?? '');
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${name}.`);
      value = next;
      index += 1;
    } else if (current.startsWith(`${name}=`)) {
      value = current.slice(name.length + 1);
      if (!value) throw new Error(`Missing value for ${name}.`);
    } else {
      rest.push(current);
    }
  }
  return { value, rest };
}

function requirePath(value: string | undefined, label: string, deps: HomeCommandDeps): string {
  if (!value) throw new Error(`Missing ${label}.`);
  const resolved = deps.resolvePath(value);
  if (!resolved) throw new Error(`Invalid ${label}.`);
  return resolved;
}

async function showHomeHelp(): Promise<void> {
  // Home governance and Account administration are compiled Action leaves
  // under this root. Their rows come from the same descriptor dispatch and
  // completion use, so this page cannot hide or misstate them.
  const { listCompiledActionCliUsageLinesForRoot } = await import('@/cli/actions/commandHelp');
  const compiled = listCompiledActionCliUsageLinesForRoot(['home']);
  const page: HelpPageOptions = {
    title: 'home',
    subtitle: 'Create, connect, and administer Personal Homes',
    usage: [
      { label: 'happier home create [--ssh user@host] [--channel stable|preview|dev] [--mode user|system] [--link-account auto|never] [--replace-services] [--switch-channel] [--yes] [--json]', description: '' },
      { label: 'happier home pair-device [--home PROFILE] [--copy-link]', description: '' },
      { label: 'happier home link-account [--home PROFILE] [--relink]', description: '' },
      { label: 'happier home unlink-account [--home PROFILE]', description: '' },
      { label: 'happier home status [--ssh user@host]', description: '' },
      { label: 'happier home backup [--output PATH] [--ssh user@host]', description: '' },
      { label: 'happier home verify-backup PATH [--ssh user@host]', description: '' },
      { label: 'happier home restore PATH [--ssh user@host] [--yes]', description: '' },
      { label: 'happier home recover-restore [--ssh user@host] [--yes]', description: '' },
      { label: 'happier home relocate --target user@host [--recovery-action finish_move|return_to_source] [--yes]', description: '' },
      { label: 'happier home erase [--ssh user@host] [--backup-first --backup-output PATH] [--yes]', description: '' },
    ],
    sections: [
      ...(compiled.length > 0 ? [{
        title: 'Home administration:',
        rows: compiled.map((row) => ({ label: row, description: '' })),
      }] : []),
      {
        title: 'Runtime targeting options:',
        rows: [
          { label: '--channel stable|preview|dev', description: '' },
          { label: '--mode user|system', description: '' },
        ],
      },
      {
        title: 'Home creation:',
        rows: [
          { label: 'create', description: 'Installs or reuses the managed runtime and atomically creates a Personal Home.' },
          { label: '--ssh user@host', description: 'Creates on a trusted remote host; public ingress is not required for Iroh reachability.' },
          { label: '--replace-services', description: 'Explicitly replaces conflicting managed services while creating this Home.' },
          { label: '--switch-channel', description: 'Explicitly changes the default managed release channel when creation requires it.' },
          { label: 'pair-device', description: 'Starts a new short-lived QR/link session.' },
          { label: 'link-account', description: 'Makes this Home available on your other devices.' },
          { label: 'unlink-account', description: 'Stops future account-based sign-in; devices already signed in keep their access until revoked on the Home.' },
          { label: 'remote administration', description: 'status, backup, verify-backup, restore, recover-restore, and erase accept --ssh.' },
          { label: '--trusted-host-key LINE', description: '--yes trusts an unknown host on first use but never a changed key; this pins the exact new known_hosts line instead.' },
          { label: 'relocate', description: 'Moves this computer\'s Personal Home to the explicit SSH destination in --target.' },
        ],
      },
      {
        title: 'Erase safety:',
        rows: [
          { label: 'backup offer', description: 'erase offers a verified backup before its single destructive confirmation.' },
          { label: '--backup-first --backup-output PATH', description: 'Takes that verified backup without a prompt; PATH must be outside the erased Home data.' },
          { label: '--yes', description: 'Confirms deletion and never creates a backup implicitly.' },
        ],
      },
    ],
  };
  console.log(renderHelpPage(page));
}

function parseRuntimeChannel(value: string | null, defaultChannel: 'stable' | 'preview' | 'dev'): 'stable' | 'preview' | 'dev' {
  if (value === null) return defaultChannel;
  if (value === 'stable' || value === 'preview' || value === 'dev') return value;
  throw Object.assign(new Error(`Unsupported Personal Home runtime channel: ${value}`), { code: 'invalid_runtime_target' });
}

function parseRuntimeMode(value: string | null): 'user' | 'system' {
  if (value === null) return 'user';
  if (value === 'user' || value === 'system') return value;
  throw Object.assign(new Error(`Unsupported Personal Home runtime mode: ${value}`), { code: 'invalid_runtime_target' });
}

function parseLinkAccountMode(value: string | null): 'auto' | 'never' {
  if (value === null || value === 'auto') return 'auto';
  if (value === 'never') return 'never';
  throw Object.assign(new Error(`Unsupported account linking mode: ${value}`), { code: 'invalid_params' });
}

function parseRelocationRecovery(value: unknown): PersonalHomeRelocationRecovery {
  if (!isRecord(value)) {
    throw Object.assign(new Error('Personal Home inspection returned invalid relocation recovery facts.'), { code: 'personal_home_inspection_incomplete' });
  }
  if (value.status === 'none') return { status: 'none' };
  if (value.status === 'ambiguous') return { status: 'ambiguous' };
  const operationId = typeof value.operationId === 'string' ? value.operationId.trim() : '';
  const destinationMachineId = typeof value.destinationMachineId === 'string' ? value.destinationMachineId.trim() : '';
  const sourceDescriptorRevision = value.sourceDescriptorRevision;
  if (value.status !== 'recovery_available'
    || !operationId
    || !destinationMachineId
    || typeof sourceDescriptorRevision !== 'number'
    || !Number.isSafeInteger(sourceDescriptorRevision)
    || sourceDescriptorRevision < 1
    || value.primaryAction !== 'finish_move'
    || (value.secondaryAction !== undefined && value.secondaryAction !== 'return_to_source')) {
    throw Object.assign(new Error('Personal Home inspection returned invalid relocation recovery facts.'), { code: 'personal_home_inspection_incomplete' });
  }
  return {
    status: 'recovery_available',
    operationId,
    destinationMachineId,
    sourceDescriptorRevision,
    primaryAction: 'finish_move',
    ...(value.secondaryAction === 'return_to_source' ? { secondaryAction: 'return_to_source' as const } : {}),
  };
}

function parseRelocationRecoveryAction(value: string | null): 'finish_move' | 'return_to_source' | null {
  if (value === null) return null;
  if (value === 'finish_move' || value === 'return_to_source') return value;
  throw Object.assign(new Error('--recovery-action must be finish_move or return_to_source.'), { code: 'invalid_params' });
}

async function resolvePostCreateHomeLink(params: Readonly<{
  mode: 'auto' | 'never';
  canAttempt: boolean;
  homeServerIdentityId: string;
  linkAccount?: HomeCommandDeps['linkAccount'];
  signal?: AbortSignal;
  expectedAccountServiceSelection?: Readonly<{ endpoint: string; serverIdentityId: string }>;
}>): Promise<HomePostCreateLinkResult> {
  if (params.mode === 'never' || !params.canAttempt || !params.linkAccount) {
    return { kind: params.mode === 'never' ? 'not_requested' : 'unable_to_attempt' };
  }
  try {
    return await params.linkAccount({
      homeServerIdentityId: params.homeServerIdentityId,
      relink: false,
      signal: params.signal,
      ...(params.expectedAccountServiceSelection
        ? { expectedAccountServiceSelection: params.expectedAccountServiceSelection }
        : {}),
    });
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * The sign-in-only command for the service this CLI already selected, or the
 * built-in default service `happier setup` would use when none is selected.
 */
function signInCommand(selectedEndpoint: string | undefined): string {
  return `happier auth service use ${selectedEndpoint ?? DEFAULT_HAPPIER_CLOUD_SERVER_URL}`;
}

/** One human sentence per typed reason a link or unlink could not start. */
function describeHomeLinkUnavailable(
  operation: 'link' | 'unlink',
  reason: CliHomeLinkUnavailableReason,
  selectedEndpoint?: string,
): string {
  switch (reason) {
    case 'account_service_credentials_unavailable':
      return operation === 'link'
        ? `Sign in first with \`${signInCommand(selectedEndpoint)}\`, then run this command again.`
        : 'No sign-in service is selected on this computer. Select the service this Home is linked to with `happier auth service use <address>`, then run this command again.';
    case 'home_profile_unavailable':
      return 'This computer has no verified connection to that Home. Connect to the Home first, then run this command again.';
    case 'home_credentials_unavailable':
      return 'This computer is not signed in to that Home. Sign in to the Home first, then run this command again.';
    case 'home_transport_unavailable':
      return 'The Home did not answer. Check that it is running and reachable, then run this command again.';
  }
}

function renderPostCreateHomeLink(
  result: HomePostCreateLinkResult,
  homeServerIdentityId: string,
  reentryCommand = `happier home link-account --home ${homeServerIdentityId}`,
  knownAccountServiceEndpoint?: string,
): void {
  if (result.kind === 'linked' || result.kind === 'not_requested') return;
  if (result.kind === 'unavailable' && result.reason === 'account_service_credentials_unavailable') {
    const endpoint = result.selectedEndpoint ?? knownAccountServiceEndpoint;
    console.log(`This Home is not linked to your account. Sign in first with \`${signInCommand(endpoint)}\`, then run \`happier home link-account --home ${homeServerIdentityId}\`.`);
    return;
  }
  if (result.kind === 'relink_required') {
    console.log(`This Home is linked using different trust facts. Review and rerun \`happier home link-account --home ${homeServerIdentityId} --relink\`.`);
    return;
  }
  console.log(`The Home is ready, but account linking did not complete. Retry with \`${reentryCommand}\`.`);
}

async function runTask(params: Readonly<{
  runner: CliSystemTasksRunnerAdapter;
  spec: SystemTaskSpec;
  json: boolean;
  visible: boolean;
  signal?: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  onPrompt?: (prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>, message: string) => Promise<unknown>;
  projectData?: (data: SystemTaskJsonValue) => SystemTaskJsonValue;
}>): Promise<SystemTaskJsonValue> {
  const rawResult = await runSystemTaskToCompletion({
    runner: params.runner,
    spec: params.spec,
    signal: params.signal,
    sleep: params.sleep,
    onPrompt: params.onPrompt,
    onEvent: params.visible
      ? async (event: SystemTaskEvent) => {
          if (params.json) await writeJsonStdout(event);
          else if (event.type !== 'prompt' && (event.message || event.stepId)) console.log(event.message ?? event.stepId);
        }
      : undefined,
  });
  const result = rawResult.ok && params.projectData
    ? { ...rawResult, data: params.projectData(rawResult.data ?? null) }
    : rawResult;
  if (params.visible && params.json) await writeJsonStdout({
    kind: 'personal_home_task_result',
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    result,
  });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, personalHomeTaskFailure: true });
  return result.data ?? null;
}

/**
 * The manage-host task owns the host-neutral refusal sentence for its reconciliation codes. The
 * CLI host only appends the remedy it can actually offer: the explicit create flag (also the
 * way past a `--yes` decline).
 */
function withRemoteCreateCliRemedy(error: unknown): unknown {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
  const flag = code === 'service_reconciliation_declined'
    ? '--replace-services'
    : code === 'release_channel_switch_declined'
      ? '--switch-channel'
      : null;
  if (!flag || !(error instanceof Error)) return error;
  return Object.assign(new Error(`${error.message} Or rerun with ${flag}.`), { code, personalHomeTaskFailure: true });
}

async function readPersonalHomePurpose(params: Readonly<{
  runner: CliSystemTasksRunnerAdapter;
  signal?: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  runtime: Readonly<{
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
  }>;
}>): Promise<PersonalHomePurpose> {
  const data = await runTask({
    ...params,
    json: false,
    visible: false,
    spec: {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      kind: 'relay.runtime.status.v1',
      params: { target: { kind: 'local' }, ...params.runtime },
    },
  });
  if (!isRecord(data) || !isRecord(data.purpose) || data.purpose.kind !== 'personal-home') {
    throw Object.assign(new Error('The installed managed runtime is not a Personal Home.'), { code: 'purpose_not_personal_home' });
  }
  const canonicalServerUrl = typeof data.purpose.canonicalServerUrl === 'string'
    ? data.purpose.canonicalServerUrl.trim()
    : '';
  if (!canonicalServerUrl) throw Object.assign(new Error('Personal Home status did not provide its Home address.'), { code: 'personal_home_status_incomplete' });
  return { kind: 'personal-home', canonicalServerUrl };
}

function taskSpec(
  kind: string,
  purpose: PersonalHomePurpose,
  runtime: Readonly<{ channel: 'stable' | 'preview' | 'dev'; mode: 'user' | 'system' }>,
  extra: Record<string, SystemTaskJsonValue> = {},
): SystemTaskSpec {
  return {
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    kind,
    params: { target: { kind: 'local' }, ...runtime, purpose, ...extra },
  };
}

type PersonalHomeOperationLabel = 'Backup' | 'Restore' | 'Erase';

function printSafeFacts(data: SystemTaskJsonValue, operation?: PersonalHomeOperationLabel): void {
  if (!isRecord(data)) return;
  const output = createOutputBuilder();
  let factCount = 0;
  const add = (label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      output.line(`${label}: ${value}`);
      factCount += 1;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      output.line(`${label}: ${String(value)}`);
      factCount += 1;
    }
  };
  add('Path', data.path);
  add('SHA-256', data.sha256);
  add('Outcome', data.outcome);
  add(operation ? `${operation} error` : 'Operation error', data.error);
  add('Home needs attention', data.homeNeedsAttention);
  if (isRecord(data.cleanupRequired)) {
    add('Cleanup required', data.cleanupRequired.kind);
    add('Cleanup path', data.cleanupRequired.path);
    add('Cleanup error', data.cleanupRequired.error);
  }
  add('Stopped running Home', data.stoppedRunningHome);
  add('Post-delete inspection complete', data.inspectionComplete);
  add('Post-delete inspection error', data.inspectionError);
  if (Array.isArray(data.removedPaths)) {
    for (const path of data.removedPaths) add('Removed', path);
  }
  if (Array.isArray(data.remainingOwnedPaths)) {
    for (const path of data.remainingOwnedPaths) add('Remaining owned', path);
  }
  if (Array.isArray(data.remainingUnknownPaths)) {
    for (const path of data.remainingUnknownPaths) add('Remaining unknown', path);
  }
  if (Array.isArray(data.rollbackPaths)) {
    for (const path of data.rollbackPaths) add('Rollback retained at', path);
  }
  add('Running', data.running);
  add('Identity match', data.identityMatchesCurrentHome);
  add('Destination verified', data.destinationVerified);
  add('Source stopped', data.sourceStopped);
  if (isRecord(data.manifest)) {
    add('Home identity', data.manifest.homeServerIdentityId);
    add('Created', data.manifest.createdAt);
    add('Schema', data.manifest.schemaVersion);
    add('Archive format', data.manifest.format);
    add('Archive version', data.manifest.version);
  }
  if (isRecord(data.layout)) {
    add('Data directory', data.layout.dataDir);
    add('Database', data.layout.databasePath);
    add('Public files', data.layout.publicFilesDir);
    add('Private files', data.layout.privateFilesDir);
    add('Backups', data.layout.backupsDir);
  }
  if (isRecord(data.storage)) {
    add('Database bytes', data.storage.databaseBytes);
    if (typeof data.storage.backupsCount === 'number') {
      add('Backup archives', data.storage.backupsCountComplete === false
        ? `${String(data.storage.backupsCount)}+`
        : data.storage.backupsCount);
    }
    add('Estimated owned bytes', data.storage.estimatedOwnedBytes);
    add('Erase preview complete', data.storage.estimatedOwnedBytesComplete);
    add('Erase preview reason', data.storage.estimatedOwnedBytesReason);
    if (Array.isArray(data.storage.ownedErasePaths)) {
      for (const path of data.storage.ownedErasePaths) add('Owned erase path', path);
    }
  }
  if (factCount > 0) console.log(output.render());
}

async function confirmYesNo(params: Readonly<{
  message: string;
  deps: HomeCommandDeps;
  signal?: AbortSignal;
}>): Promise<boolean> {
  return await promptConfirmYesNo(params.message, {
    default: 'no',
    maxAttempts: 3,
    promptInputFn: params.deps.promptInput,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function readRestoreRecoveryFacts(inspection: SystemTaskJsonValue): Readonly<{
  status: string;
  affectedTargets: readonly string[];
}> {
  const recovery = isRecord(inspection) && isRecord(inspection.restoreRecovery)
    ? inspection.restoreRecovery
    : null;
  return {
    status: typeof recovery?.status === 'string' ? recovery.status : '',
    affectedTargets: Array.isArray(recovery?.affectedTargets)
      ? recovery.affectedTargets.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [],
  };
}

async function confirmDestructive(params: Readonly<{
  yes: boolean;
  interactive: boolean;
  prompt: string;
  nonInteractiveMessage: string;
  deps: HomeCommandDeps;
  signal?: AbortSignal;
}>): Promise<void> {
  if (params.yes) return;
  if (!params.interactive) throw Object.assign(new Error(params.nonInteractiveMessage), { code: 'confirmation_required' });
  const confirmed = await confirmYesNo({
    message: params.prompt,
    deps: params.deps,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!confirmed) throw Object.assign(new Error('Destructive operation was not confirmed; no mutation task was started.'), { code: 'confirmation_declined' });
}

export async function handleHomeCommand(
  argsRaw: string[],
  deps: HomeCommandDeps = DEFAULT_DEPS,
  signal?: AbortSignal,
): Promise<void> {
  const subcommand = argsRaw[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    await showHomeHelp();
    return;
  }
  const jsonFlag = takeFlag(argsRaw.slice(1), '--json');
  const yesFlag = takeFlag(jsonFlag.rest, '--yes');
  const approvalStdinFlag = takeFlag(yesFlag.rest, '--approval-stdin');
  const channelFlag = takeFlagValue(approvalStdinFlag.rest, '--channel');
  const modeFlag = takeFlagValue(channelFlag.rest, '--mode');
  const linkAccountModeFlag = takeFlagValue(modeFlag.rest, '--link-account');
  const targetFlag = takeFlagValue(linkAccountModeFlag.rest, '--target');
  const recoveryActionFlag = takeFlagValue(targetFlag.rest, '--recovery-action');
  const sshFlag = takeFlagValue(recoveryActionFlag.rest, '--ssh');
  const trustedHostKeyFlag = takeFlagValue(sshFlag.rest, '--trusted-host-key');
  const backupFirstFlag = takeFlag(trustedHostKeyFlag.rest, '--backup-first');
  const backupOutputFlag = takeFlagValue(backupFirstFlag.rest, '--backup-output');
  const replaceServicesFlag = takeFlag(backupOutputFlag.rest, '--replace-services');
  const switchChannelFlag = takeFlag(replaceServicesFlag.rest, '--switch-channel');
  const runtime = {
    channel: parseRuntimeChannel(channelFlag.value, deps.resolveDefaultChannel()),
    mode: parseRuntimeMode(modeFlag.value),
  } as const;
  let args = switchChannelFlag.rest;
  const json = jsonFlag.present;
  const interactive = deps.isInteractiveTerminal() && !json;
  const promptUser = async (prompt: string): Promise<string> => signal
    ? await deps.promptInput(prompt, { signal })
    : await deps.promptInput(prompt);
  if (approvalStdinFlag.present && yesFlag.present) {
    throw Object.assign(new Error('Do not combine --approval-stdin with --yes.'), { code: 'invalid_params' });
  }
  if (targetFlag.value !== null && subcommand !== 'relocate') {
    throw Object.assign(new Error('--target is supported only by `happier home relocate`.'), { code: 'invalid_params' });
  }
  if (recoveryActionFlag.value !== null && subcommand !== 'relocate') {
    throw Object.assign(new Error('--recovery-action is supported only by `happier home relocate`.'), { code: 'invalid_params' });
  }
  /** The exact known_hosts line to accept without a prompt, for an unattended run
   * against a host whose key legitimately changed. */
  const trustedHostKey = normalizeTrustedHostKeyFlag(trustedHostKeyFlag.value);
  if (trustedHostKey && !sshFlag.value && subcommand !== 'relocate') {
    throw Object.assign(
      new Error('--trusted-host-key applies to a Personal Home reached over SSH.'),
      { code: 'invalid_params' },
    );
  }
  const sshHostTrust: SystemTaskJsonObject = trustedHostKey ? { trustedHostKey } : {};
  if ((backupFirstFlag.present || backupOutputFlag.value !== null) && subcommand !== 'erase') {
    throw Object.assign(new Error('--backup-first and --backup-output are supported only by `happier home erase`.'), { code: 'invalid_params' });
  }
  if (backupOutputFlag.value !== null && !backupFirstFlag.present) {
    throw Object.assign(new Error('--backup-output requires --backup-first.'), { code: 'invalid_params' });
  }
  if (backupFirstFlag.present && approvalStdinFlag.present) {
    throw Object.assign(
      new Error('--backup-first is not available under --approval-stdin; the invoking client owns the pre-erase backup offer.'),
      { code: 'invalid_params' },
    );
  }
  if ((replaceServicesFlag.present || switchChannelFlag.present) && subcommand !== 'create') {
    throw Object.assign(
      new Error('--replace-services and --switch-channel are supported only by `happier home create`.'),
      { code: 'invalid_params' },
    );
  }
  /** Resolves the plan-required pre-erase verified-backup offer into an explicit
   * destination outside the erased data, or `null` when no backup was chosen. */
  const resolvePreEraseBackupOutputPath = async (): Promise<string | null> => {
    const chosen = backupFirstFlag.present
      || (interactive && !yesFlag.present && !approvalStdinFlag.present
        && await confirmYesNo({
          message: 'Create and verify a Personal Home backup before erasing data?',
          deps,
          ...(signal ? { signal } : {}),
        }));
    if (!chosen) return null;
    const requested = backupOutputFlag.value
      ?? (interactive ? (await promptUser('Destination for the verified pre-erase backup: ')).trim() : '');
    if (!requested) {
      throw Object.assign(
        new Error('A pre-erase verified backup requires --backup-output PATH outside the Personal Home data roots.'),
        { code: 'backup_output_required' },
      );
    }
    return requirePath(requested, 'pre-erase backup output path', deps);
  };
  /** Verified pre-erase backup target, rebound against the erase confirmation facts. */
  let preEraseVerifiedIdentity: string | null = null;
  let verifiedLocalPreEraseBackupPath: string | null = null;
  let remotePreEraseTarget: Readonly<{
    sshHost: string;
    canonicalServerUrl: string;
    homeServerIdentityId: string;
    paths: readonly string[];
  }> | null = null;
  let eraseTargetDriftedAfterBackup = false;
  const readVerifiedPreEraseBackupIdentity = (
    backup: SystemTaskJsonValue,
    verification: SystemTaskJsonValue,
    requestedOutputPath: string,
  ): string => {
    const cleanupRequired = isRecord(backup) && isRecord(backup.cleanupRequired)
      ? backup.cleanupRequired
      : null;
    if (cleanupRequired?.kind === 'backup_staging'
      && typeof cleanupRequired.path === 'string'
      && cleanupRequired.path.trim()) {
      throw Object.assign(
        new Error(`The verified backup is safe, but its protected staging copy still exists at ${cleanupRequired.path.trim()}. Remove that exact path before erasing the Home.`),
        {
          code: 'personal_home_backup_cleanup_required',
          cleanupPath: cleanupRequired.path.trim(),
          personalHomeTaskFailure: true,
        },
      );
    }
    const backupPath = isRecord(backup) && typeof backup.path === 'string' ? backup.path.trim() : '';
    const backupIdentity = isRecord(backup) && isRecord(backup.manifest) && typeof backup.manifest.homeServerIdentityId === 'string'
      ? backup.manifest.homeServerIdentityId.trim()
      : '';
    if (!backupPath
      || !backupIdentity
      || !isRecord(backup)
      || typeof backup.sha256 !== 'string'
      || !isHappierRuntimePathWithinRoot(backupPath, requestedOutputPath)
      || !isHappierRuntimePathWithinRoot(requestedOutputPath, backupPath)) {
      throw Object.assign(
        new Error('The pre-erase backup did not return verified final facts at the requested destination; erase was not started.'),
        { code: 'invalid_backup_result' },
      );
    }
    if (!isRecord(verification) || !isRecord(verification.manifest)) {
      throw Object.assign(
        new Error('The pre-erase backup did not return a valid manifest; erase was not started.'),
        { code: 'invalid_backup_manifest' },
      );
    }
    if (verification.manifest.format !== 'happier-personal-home-backup' || verification.manifest.version !== 1) {
      throw Object.assign(
        new Error('The pre-erase backup schema is unsupported; erase was not started.'),
        { code: 'unsupported_backup_schema' },
      );
    }
    if (verification.identityMatchesCurrentHome !== 'match'
      || verification.manifest.homeServerIdentityId !== backupIdentity) {
      throw Object.assign(
        new Error('The pre-erase backup does not verify against this Personal Home; erase was not started.'),
        { code: 'identity_mismatch' },
      );
    }
    return backupIdentity;
  };
  const failOnEraseTargetDrift = (error: unknown): never => {
    if (!eraseTargetDriftedAfterBackup) throw error;
    throw Object.assign(
      new Error('The Personal Home changed after the verified backup; nothing was erased.'),
      { code: 'identity_mismatch' },
    );
  };
  if (subcommand === 'create') {
    const aliasFlag = takeFlag(args, '--this-computer');
    args = aliasFlag.rest;
    if (args.length > 0) throw new Error(`Unknown home create arguments: ${args.join(' ')}`);
    if (aliasFlag.present && sshFlag.value) {
      throw Object.assign(new Error('Do not combine --this-computer with --ssh.'), { code: 'invalid_params' });
    }
    const linkAccountMode = parseLinkAccountMode(linkAccountModeFlag.value);
    if (!yesFlag.present && !interactive) {
      throw Object.assign(
        new Error('Personal Home creation requires an interactive terminal or explicit --yes.'),
        { code: 'interactive_required' },
      );
    }
    const confirmedAccountService = !yesFlag.present && linkAccountMode === 'auto'
        ? await deps.resolveSelectedAccountServicePresentation?.({ signal, timeoutMs: 6_000 })
        : null;
    if (!yesFlag.present) {
      const confirmed = await confirmYesNo({
        message: [
          sshFlag.value
            ? `Create a Personal Home on remote SSH host ${sshFlag.value} with the fixed managed preset?`
            : 'Create a Personal Home on this computer with the fixed managed preset?',
          `Mode: ${runtime.mode}`,
          `Channel: ${runtime.channel}`,
          sshFlag.value
            ? `Storage: plaintext at rest on ${sshFlag.value}; continue only if you trust that remote host.`
            : 'Storage: plaintext on this computer; use only a machine you trust.',
          linkAccountMode === 'never'
            ? 'Availability on your other devices: disabled.'
            : confirmedAccountService
              ? `Availability through ${confirmedAccountService.displayName}: enabled (${confirmedAccountService.endpoint}).`
              : 'Availability on your other devices: automatic only when the selected service can be verified.',
          'This installs or reuses the managed server, creates the initial account, closes signup, and configures the local service.',
        ].join('\n'),
        deps,
        ...(signal ? { signal } : {}),
      });
      if (!confirmed) {
        throw Object.assign(
          new Error('Personal Home creation was cancelled before any changes were made.'),
          { code: 'confirmation_declined' },
        );
      }
    }
    if (sshFlag.value) {
      const remoteData = await runTask({
        runner: deps.createRunner(runtime),
        spec: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          kind: 'remote.ssh.manageHost.v1',
          params: {
            action: 'personalHome.create',
            channel: runtime.channel,
            relayRuntime: runtime,
            pairDevice: interactive,
            // The creator always needs a Home credential. --link-account only
            // controls the separate Account Service publication performed after
            // creation succeeds.
            enrollInvokingClient: true,
            ...(replaceServicesFlag.present ? { replaceServices: true } : {}),
            ...(switchChannelFlag.present ? { switchChannel: true } : {}),
            ssh: { target: sshFlag.value, auth: 'agent', ...sshHostTrust },
          },
        },
        json,
        visible: false,
        signal,
        sleep: deps.sleep,
        onPrompt: async (prompt, message) => {
          if (prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
            if (!yesFlag.present && !interactive) {
              throw Object.assign(
                new Error('Remote background-service replacement requires an interactive terminal or explicit --replace-services.'),
                { code: 'prompt_required' },
              );
            }
            // `home create --yes` never grants replacement: --replace-services does.
            return await answerRemoteBackgroundServiceReplacementPrompt({
              data: prompt.data,
              assumeYes: yesFlag.present,
              assumeYesMeans: 'decline',
              interactive,
              message,
              confirm: async (promptMessage) => await confirmYesNo({
                message: promptMessage,
                deps,
                ...(signal ? { signal } : {}),
              }),
            });
          }
          if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
            if (yesFlag.present) return { switchDefaultReleaseChannel: false };
            if (!interactive) {
              throw Object.assign(
                new Error('Changing the remote default release channel requires an interactive terminal or explicit --switch-channel.'),
                { code: 'prompt_required' },
              );
            }
            return {
              switchDefaultReleaseChannel: await confirmYesNo({
                message: message || `Switch the remote default release channel to ${runtime.channel}?`,
                deps,
                ...(signal ? { signal } : {}),
              }),
            };
          }
          if (!isSshHostTrustPromptKind(prompt.kind)) {
            throw Object.assign(new Error(`Remote Personal Home creation requires unsupported input: ${prompt.kind}`), { code: 'prompt_required' });
          }
          return await answerSshHostTrustPrompt({
            prompt: { kind: prompt.kind, data: prompt.data },
            assumeYes: yesFlag.present,
            interactive,
            message,
            confirm: async (promptMessage) => await confirmYesNo({
              message: `${promptMessage}\nTrust this host key?`,
              deps,
              ...(signal ? { signal } : {}),
            }),
          });
        },
      }).catch((error: unknown) => {
        throw withRemoteCreateCliRemedy(error);
      });
      const created = parseRemotePersonalHomeCreateTaskData(remoteData);
      const { pairing, invokingClientEnrollment, ...createdFacts } = created;
      const accountServiceLink = await resolvePostCreateHomeLink({
        mode: linkAccountMode,
        canAttempt: invokingClientEnrollment.kind === 'enrolled' && (yesFlag.present || confirmedAccountService !== null),
        homeServerIdentityId: created.homeServerIdentityId,
        linkAccount: deps.linkAccount,
        signal,
        ...(confirmedAccountService
          ? { expectedAccountServiceSelection: {
              endpoint: confirmedAccountService.endpoint,
              serverIdentityId: confirmedAccountService.serverIdentityId,
            } }
          : {}),
      });
      const result: PersonalHomeCreateResult = {
        ...createdFacts,
        channel: runtime.channel,
        mode: runtime.mode,
        accountServiceLink,
        invokingClientEnrollment,
        ...(pairing.kind === 'not_requested' ? {} : { pairing }),
      };
      if (json) {
        await printJsonEnvelope({ ok: true, kind: 'personal_home_create', data: result }, { exitCode: 0 });
      } else {
        console.log(`Remote Personal Home ready at ${created.canonicalServerUrl}`);
        const pairingReentry = invokingClientEnrollment.kind === 'enrolled'
          ? `happier home pair-device --home ${created.homeServerIdentityId}`
          : `happier home create --ssh ${sshFlag.value} --link-account ${linkAccountMode}`;
        if (pairing.kind === 'cancelled' || pairing.kind === 'expired') {
          console.log(`Device pairing did not complete. Retry with \`${pairingReentry}\`.`);
        } else if (pairing.kind !== 'completed' && pairing.kind !== 'not_requested') {
          console.log(`The Home was created, but device pairing is incomplete. Retry with \`${pairingReentry}\`.`);
        }
        if (linkAccountMode === 'auto') {
          renderPostCreateHomeLink(
            accountServiceLink,
            created.homeServerIdentityId,
            invokingClientEnrollment.kind === 'enrolled'
              ? undefined
              : `happier home create --ssh ${sshFlag.value} --link-account auto`,
            confirmedAccountService?.endpoint,
          );
        }
      }
      return;
    }
    if (!deps.createPersonalHome || !deps.reconcileCreatedHome) {
      throw Object.assign(new Error('Local Personal Home creation is unavailable in this build.'), { code: 'personal_home_create_unavailable' });
    }
    const created = await deps.createPersonalHome(runtime, {
      allowErasedRuntimeRecreate: true,
      signal,
    });
    await deps.reconcileCreatedHome(created.profileId, {
      quiet: json,
      signal,
      ...(replaceServicesFlag.present ? { replaceServices: true } : {}),
      ...(switchChannelFlag.present ? { switchChannel: true } : {}),
    });
    if (interactive && deps.pairDevice) {
      const paired = await deps.pairDevice({ profileRef: created.profileId, copyLink: false, signal });
      if (paired.kind === 'update_required') {
        console.log('This Home requires an update before another device can be paired. Retry with `happier home pair-device`.');
      } else if (paired.kind !== 'completed' && paired.kind !== 'cancelled' && paired.kind !== 'expired') {
        console.log('Device pairing did not complete. Retry with `happier home pair-device`.');
      }
    }
    const accountServiceLink = await resolvePostCreateHomeLink({
      mode: linkAccountMode,
      canAttempt: yesFlag.present || confirmedAccountService !== null,
      homeServerIdentityId: created.homeServerIdentityId,
      linkAccount: deps.linkAccount,
      signal,
      ...(confirmedAccountService
        ? { expectedAccountServiceSelection: {
            endpoint: confirmedAccountService.endpoint,
            serverIdentityId: confirmedAccountService.serverIdentityId,
          } }
        : {}),
    });
    const result: PersonalHomeCreateResult = {
      status: 'complete',
      profileId: created.profileId,
      homeServerIdentityId: created.homeServerIdentityId,
      canonicalServerUrl: created.canonicalServerUrl,
      accountCreated: created.accountCreated,
      channel: runtime.channel,
      mode: runtime.mode,
      ...(created.descriptor ? { descriptor: created.descriptor } : {}),
      accountServiceLink,
    };
    if (json) {
      await printJsonEnvelope({ ok: true, kind: 'personal_home_create', data: result }, { exitCode: 0 });
    } else {
      console.log(`Personal Home ready at ${created.canonicalServerUrl}`);
      renderPostCreateHomeLink(accountServiceLink, created.homeServerIdentityId, undefined, confirmedAccountService?.endpoint);
    }
    return;
  }
  if (approvalStdinFlag.present && subcommand !== 'restore' && subcommand !== 'recover-restore' && subcommand !== 'erase') {
    throw Object.assign(new Error('--approval-stdin is reserved for remote destructive Home execution.'), { code: 'invalid_params' });
  }
  if (linkAccountModeFlag.value !== null) {
    throw Object.assign(new Error('--link-account is supported only by `happier home create`.'), { code: 'invalid_params' });
  }
  if (subcommand === 'pair-device') {
    if (sshFlag.value) throw Object.assign(new Error('--ssh is not supported by home pair-device.'), { code: 'invalid_params' });
    const homeFlag = takeFlagValue(args, '--home');
    const copyLinkFlag = takeFlag(homeFlag.rest, '--copy-link');
    const taskStreamFlag = takeFlag(copyLinkFlag.rest, '--system-task-stream');
    if (taskStreamFlag.rest.length > 0) throw new Error(`Unknown home pair-device arguments: ${taskStreamFlag.rest.join(' ')}`);
    if (taskStreamFlag.present) {
      if (json || copyLinkFlag.present) {
        throw Object.assign(new Error('System-task pairing stream cannot be combined with public output flags.'), { code: 'invalid_params' });
      }
      if (!deps.pairDevice) throw Object.assign(new Error('Direct Home device pairing is unavailable in this build.'), { code: 'pair_device_unavailable' });
      const outcome = await deps.pairDevice({
        ...(homeFlag.value ? { profileRef: homeFlag.value } : {}),
        copyLink: false,
        signal,
        onInvite: ({ link }) => console.log(encodeCliDirectHomeQrTaskStreamEvent({ v: 1, kind: 'home_pair_device.invite', link })),
      });
      console.log(encodeCliDirectHomeQrTaskStreamEvent({ v: 1, kind: 'home_pair_device.result', result: outcome }));
      return;
    }
    if (json) throw Object.assign(new Error('Device pairing QR and enrollment links are not available in JSON output.'), { code: 'interactive_required' });
    if (!deps.pairDevice) throw Object.assign(new Error('Direct Home device pairing is unavailable in this build.'), { code: 'pair_device_unavailable' });
    if (!deps.isInteractiveTerminal() && !copyLinkFlag.present) {
      throw Object.assign(new Error('A terminal is required to render the QR code; use --copy-link for the explicit link-only flow.'), { code: 'interactive_required' });
    }
    const outcome = await deps.pairDevice({
      ...(homeFlag.value ? { profileRef: homeFlag.value } : {}),
      copyLink: copyLinkFlag.present,
      signal,
    });
    if (outcome.kind === 'completed') {
      console.log(`Device paired${outcome.requestedDeviceLabel ? `: ${outcome.requestedDeviceLabel}` : '.'}`);
      return;
    }
    if (outcome.kind === 'cancelled') throw Object.assign(new Error('Device pairing was cancelled.'), { code: 'cancelled' });
    if (outcome.kind === 'expired') throw Object.assign(new Error('The pairing session expired. Run `happier home pair-device` to start a new session.'), { code: 'pairing_expired' });
    if (outcome.kind === 'update_required') throw Object.assign(new Error('This Home does not advertise the required bound-qr-v2 capability. Update the Home and retry.'), { code: 'update_required' });
    if (outcome.kind === 'invalid_request') throw Object.assign(new Error('The joining device request did not match this Home QR session.'), { code: 'invalid_pairing_request' });
    if (outcome.kind === 'failed') throw Object.assign(new Error(`Device pairing failed (${outcome.status}).`), { code: 'pairing_failed' });
    throw Object.assign(new Error('Device pairing did not reach a terminal state.'), { code: 'pairing_failed' });
  }
  if (subcommand === 'link-account') {
    if (sshFlag.value) throw Object.assign(new Error('--ssh is not supported by home link-account.'), { code: 'invalid_params' });
    const homeFlag = takeFlagValue(args, '--home');
    const relinkFlag = takeFlag(homeFlag.rest, '--relink');
    if (relinkFlag.rest.length > 0) throw new Error(`Unknown home link-account arguments: ${relinkFlag.rest.join(' ')}`);
    if (!deps.linkAccount) throw Object.assign(new Error('Account-based Home linking is unavailable in this build.'), { code: 'link_account_unavailable' });
    const outcome = await deps.linkAccount({
      ...(homeFlag.value ? { homeServerIdentityId: homeFlag.value } : {}),
      relink: relinkFlag.present,
      signal,
    });
    if (outcome.kind === 'linked') {
      console.log('This Home is now available on your other devices.');
      return;
    }
    if (outcome.kind === 'relink_required' && !relinkFlag.present) {
      throw Object.assign(new Error('This Home is already linked using different trust facts. Rerun with --relink only after reviewing that replacement.'), { code: 'relink_required' });
    }
    if (outcome.kind === 'unavailable') {
      throw Object.assign(
        new Error(describeHomeLinkUnavailable('link', outcome.reason, outcome.selectedEndpoint)),
        { code: outcome.reason },
      );
    }
    if (outcome.kind === 'cancelled') throw Object.assign(new Error('Home linking was cancelled.'), { code: 'cancelled' });
    if (outcome.kind === 'relink_required') throw Object.assign(new Error('Account relinking was not accepted.'), { code: 'relink_required' });
    throw Object.assign(new Error('Account-based Home linking failed.'), { code: 'link_account_failed' });
  }
  if (subcommand === 'unlink-account') {
    if (sshFlag.value) throw Object.assign(new Error('--ssh is not supported by home unlink-account.'), { code: 'invalid_params' });
    const homeFlag = takeFlagValue(args, '--home');
    if (homeFlag.rest.length > 0) throw new Error(`Unknown home unlink-account arguments: ${homeFlag.rest.join(' ')}`);
    if (!deps.unlinkAccount) throw Object.assign(new Error('Account-based Home unlinking is unavailable in this build.'), { code: 'unlink_account_unavailable' });
    const outcome = await deps.unlinkAccount({
      ...(homeFlag.value ? { homeServerIdentityId: homeFlag.value } : {}),
      signal,
    });
    if (outcome.kind === 'unlinked') {
      // Truthful about the exact boundary: the refusal is forward-looking, and
      // sessions the service already obtained are the Home's to revoke.
      console.log('Stopped future account-based sign-in for this Home.');
      console.log('Devices already signed in keep their access until signed out on the Home.');
      return;
    }
    if (outcome.kind === 'unavailable') throw Object.assign(new Error(describeHomeLinkUnavailable('unlink', outcome.reason)), { code: outcome.reason });
    if (outcome.kind === 'cancelled') throw Object.assign(new Error('Home unlinking was cancelled.'), { code: 'cancelled' });
    throw Object.assign(new Error('Account-based Home unlinking failed.'), { code: 'unlink_account_failed' });
  }
  if (subcommand === 'relocate') {
    if (sshFlag.value) throw Object.assign(new Error('Use --target, not --ssh, to select the relocation destination.'), { code: 'invalid_params' });
    const target = targetFlag.value?.trim() ?? '';
    if (!target || args.length > 0) {
      throw Object.assign(new Error('Usage: happier home relocate --target user@host [--recovery-action finish_move|return_to_source] [--yes]'), { code: 'invalid_params' });
    }
    if (!deps.readRelocationSourceProfile || !deps.publishRelocationDescriptor || !deps.readRelocationDescriptor) {
      throw Object.assign(new Error('Personal Home relocation profile publication is unavailable in this build.'), { code: 'relocation_unavailable' });
    }
    const runner = deps.createRunner(runtime);
    const purpose = await readPersonalHomePurpose({ runner, signal, sleep: deps.sleep, runtime });
    const inspection = await runTask({
      runner,
      spec: taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect, purpose, runtime),
      json: false,
      visible: false,
      signal,
      sleep: deps.sleep,
    });
    const inspectionRecord = isRecord(inspection) ? inspection : null;
    const recovery = parseRelocationRecovery(inspectionRecord?.relocationRecovery);
    if (recovery.status === 'ambiguous') {
      throw Object.assign(new Error('Personal Home relocation recovery state is ambiguous; repair is required before another move.'), { code: 'relocation_recovery_ambiguous' });
    }
    const source = await deps.readRelocationSourceProfile();
    const sourceDescriptor = HomeConnectionDescriptorV1Schema.parse(source.descriptor);
    const inspectedHomeServerIdentityId = isRecord(inspectionRecord?.identity)
      && typeof inspectionRecord.identity.homeServerIdentityId === 'string'
      ? inspectionRecord.identity.homeServerIdentityId.trim()
      : '';
    if (!inspectedHomeServerIdentityId) {
      throw Object.assign(new Error('Personal Home inspection did not return the managed Home identity.'), { code: 'personal_home_inspection_incomplete' });
    }
    if (inspectedHomeServerIdentityId !== sourceDescriptor.homeServerIdentityId) {
      throw Object.assign(new Error('The active Home profile does not match this computer\'s managed Personal Home.'), { code: 'home_profile_mismatch' });
    }
    if (recovery.status === 'none' && sourceDescriptor.canonicalServerUrl !== purpose.canonicalServerUrl) {
      throw Object.assign(new Error('The active Home profile does not match this computer\'s managed Personal Home.'), { code: 'home_profile_mismatch' });
    }
    const requestedRecoveryAction = parseRelocationRecoveryAction(recoveryActionFlag.value);
    let recoveryAction: 'finish_move' | 'return_to_source' | undefined;
    let operationId: string;
    let sourceDescriptorRevision: number;
    if (recovery.status === 'recovery_available') {
      if (target !== recovery.destinationMachineId) {
        throw Object.assign(new Error(`The interrupted relocation is reserved for SSH destination ${recovery.destinationMachineId}; refuse to resume it through ${target}.`), { code: 'relocation_destination_mismatch' });
      }
      if (requestedRecoveryAction === 'return_to_source' && recovery.secondaryAction !== 'return_to_source') {
        throw Object.assign(new Error('Return to the original Home is no longer safe because destination publication has advanced.'), { code: 'relocation_recovery_action_unavailable' });
      }
      if (requestedRecoveryAction) {
        recoveryAction = requestedRecoveryAction;
      } else {
        if (!interactive) {
          throw Object.assign(new Error('Interrupted relocation recovery requires --recovery-action finish_move or return_to_source.'), { code: 'relocation_recovery_action_required' });
        }
        const available = recovery.secondaryAction === 'return_to_source'
          ? 'finish_move or return_to_source'
          : 'finish_move';
        const selected = (await promptUser(`Interrupted relocation found. Choose ${available}: `)).trim();
        const selectedAction = parseRelocationRecoveryAction(selected);
        if (!selectedAction) {
          throw Object.assign(new Error('A relocation recovery action is required.'), { code: 'relocation_recovery_action_required' });
        }
        recoveryAction = selectedAction;
        if (recoveryAction === 'return_to_source' && recovery.secondaryAction !== 'return_to_source') {
          throw Object.assign(new Error('Return to the original Home is no longer safe because destination publication has advanced.'), { code: 'relocation_recovery_action_unavailable' });
        }
      }
      operationId = recovery.operationId;
      sourceDescriptorRevision = recovery.sourceDescriptorRevision;
    } else {
      if (requestedRecoveryAction) {
        throw Object.assign(new Error('No interrupted Personal Home relocation is available for recovery.'), { code: 'relocation_recovery_unavailable' });
      }
      await confirmDestructive({
        yes: yesFlag.present,
        interactive,
        prompt: [
          `Move ${source.name || 'this Personal Home'} to SSH destination ${target}?`,
          `Home: ${sourceDescriptor.canonicalServerUrl}`,
          `Home identity: ${sourceDescriptor.homeServerIdentityId}`,
          'The source will stop before the final backup and remain quarantined after publication.',
        ].join('\n'),
        nonInteractiveMessage: 'Personal Home relocation requires an interactive terminal or explicit --yes.',
        deps,
        ...(signal ? { signal } : {}),
      });
      operationId = (deps.createRelocationOperationId ?? (() => `relocation-${randomUUID()}`))();
      sourceDescriptorRevision = sourceDescriptor.revision;
    }
    const relocationData = await runTask({
      runner,
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'remote.ssh.manageHost.v1',
        params: {
          action: 'personalHome.relocate',
          channel: runtime.channel,
          relayRuntime: runtime,
          personalHomeRelocation: {
            operationId,
            destinationMachineId: target,
            sourceDescriptorRevision,
            ...(recoveryAction ? { recoveryAction } : {}),
          },
          ssh: { target, auth: 'agent', ...sshHostTrust },
        },
      },
      json: false,
      visible: false,
      signal,
      sleep: deps.sleep,
      onPrompt: async (prompt, message) => {
        if (isSshHostTrustPromptKind(prompt.kind)) {
          return await answerSshHostTrustPrompt({
            prompt: { kind: prompt.kind, data: prompt.data },
            assumeYes: yesFlag.present,
            interactive,
            message,
            confirm: async (promptMessage) => await confirmYesNo({
              message: `${promptMessage}\nTrust this host key?`,
              deps,
              ...(signal ? { signal } : {}),
            }),
          });
        }
        if (prompt.data.operationId !== operationId || prompt.data.homeServerIdentityId !== sourceDescriptor.homeServerIdentityId) {
          throw Object.assign(new Error('Personal Home relocation prompt did not match the requested operation.'), { code: 'prompt_mismatch' });
        }
        if (prompt.kind === 'personal_home.publish_relocation_descriptor.v1') {
          const descriptor = HomeConnectionDescriptorV1Schema.parse(prompt.data.connectionDescriptor);
          if (descriptor.homeServerIdentityId !== sourceDescriptor.homeServerIdentityId) {
            throw Object.assign(new Error('Personal Home relocation publication targeted another Home.'), { code: 'home_identity_mismatch' });
          }
          const published = HomeConnectionDescriptorV1Schema.parse(
            await deps.publishRelocationDescriptor!({ profileId: source.profileId, descriptor }),
          );
          if (published.homeServerIdentityId !== sourceDescriptor.homeServerIdentityId) {
            throw Object.assign(new Error('Personal Home relocation publication returned another Home.'), { code: 'home_identity_mismatch' });
          }
          return { descriptor: published };
        }
        if (prompt.kind === 'personal_home.read_relocation_descriptor.v1') {
          const currentRaw = await deps.readRelocationDescriptor!({
            profileId: source.profileId,
            homeServerIdentityId: sourceDescriptor.homeServerIdentityId,
          });
          const current = currentRaw === null ? null : HomeConnectionDescriptorV1Schema.parse(currentRaw);
          if (current && current.homeServerIdentityId !== sourceDescriptor.homeServerIdentityId) {
            throw Object.assign(new Error('Personal Home relocation readback returned another Home.'), { code: 'home_identity_mismatch' });
          }
          return { descriptor: current };
        }
        throw Object.assign(new Error(`Personal Home relocation requires unsupported input: ${prompt.kind}`), { code: 'prompt_required' });
      },
    });
    const relocationResult = isRecord(relocationData) && relocationData.action === 'personalHome.relocate'
      ? parsePersonalHomeRelocationResult(relocationData.personalHome)
      : null;
    if (!relocationResult) {
      throw Object.assign(new Error('Personal Home relocation returned an invalid result.'), { code: 'invalid_cli_response' });
    }
    if (relocationResult.status === 'pending') {
      const recoveryCommand = `happier home relocate --target ${target} --recovery-action ${relocationResult.recoveryAction}`;
      throw Object.assign(
        new Error(`Personal Home relocation is pending; both Homes remain stopped. Continue with \`${recoveryCommand}\`.`),
        {
          code: 'personal_home_relocation_incomplete',
          personalHomeTaskFailure: true,
          status: relocationResult.status,
          recoveryAction: relocationResult.recoveryAction,
        },
      );
    }
    if (json) {
      await printJsonEnvelope({ ok: true, kind: 'personal_home_relocation', data: relocationResult }, { exitCode: 0 });
    } else {
      console.log(`Personal Home relocation ${relocationResult.status}.`);
      if (relocationResult.destinationCleanupNeedsAttention === true) {
        console.log(`Destination cleanup needs attention. Retry with \`happier home relocate --target ${target} --recovery-action finish_move\`.`);
      }
    }
    return;
  }
  if (sshFlag.value) {
    const actionByCommand = {
      status: 'personalHome.status',
      backup: 'personalHome.backup',
      'verify-backup': 'personalHome.verifyBackup',
      restore: 'personalHome.restore',
      'recover-restore': 'personalHome.recoverRestore',
      erase: 'personalHome.erase',
    } as const;
    const action = actionByCommand[subcommand as keyof typeof actionByCommand];
    if (!action) throw Object.assign(new Error(`--ssh is not supported by home ${subcommand}.`), { code: 'invalid_params' });
    let personalHomeOperation: SystemTaskJsonObject | undefined;
    if (subcommand === 'status' || subcommand === 'recover-restore' || subcommand === 'erase') {
      if (args.length > 0) throw Object.assign(new Error(`Unknown home ${subcommand} arguments: ${args.join(' ')}`), { code: 'invalid_params' });
    } else if (subcommand === 'backup') {
      const output = takeFlagValue(args, '--output');
      if (output.rest.length > 0) throw Object.assign(new Error(`Unknown home backup arguments: ${output.rest.join(' ')}`), { code: 'invalid_params' });
      if (output.value !== null) personalHomeOperation = { outputPath: requirePath(output.value, 'backup output path', deps) };
    } else {
      if (args.length !== 1) throw Object.assign(new Error(`Usage: happier home ${subcommand} --ssh user@host PATH${subcommand === 'restore' ? ' [--yes]' : ''}`), { code: 'invalid_params' });
      personalHomeOperation = { archivePath: requirePath(args[0], 'backup archive path', deps) };
    }
    const runRemoteAction = async (
      remoteAction: (typeof actionByCommand)[keyof typeof actionByCommand],
      operation?: SystemTaskJsonObject,
    ): Promise<SystemTaskJsonValue> => await runTask({
      runner: deps.createRunner(runtime),
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'remote.ssh.manageHost.v1',
        params: {
          action: remoteAction,
          channel: runtime.channel,
          relayRuntime: runtime,
          ssh: { target: sshFlag.value, auth: 'agent', ...sshHostTrust },
          ...(operation ? { personalHomeOperation: operation } : {}),
        },
      },
      json: false,
      visible: false,
      signal,
      sleep: deps.sleep,
      onPrompt: async (prompt, message) => {
        // A pre-erase backup already bound this erase to the previous host
        // identity, so a replacement key ends the operation outright — not even
        // an interactive confirmation can re-point it at another host.
        if (prompt.kind === 'ssh.replaceHostKey' && remotePreEraseTarget !== null) {
          return { trusted: false };
        }
        if (isSshHostTrustPromptKind(prompt.kind)) {
          return await answerSshHostTrustPrompt({
            prompt: { kind: prompt.kind, data: prompt.data },
            assumeYes: yesFlag.present,
            interactive,
            message,
            confirm: async (promptMessage) => await confirmYesNo({
              message: `${promptMessage}\nTrust this host key?`,
              deps,
              ...(signal ? { signal } : {}),
            }),
          });
        }
        if (prompt.kind.startsWith('personal_home.confirm_remote_')) {
          const data = prompt.data;
          const paths = Array.isArray(data.paths) ? data.paths.filter((path): path is string => typeof path === 'string') : [];
          const expectedTarget = remotePreEraseTarget;
          if (expectedTarget !== null && data.sshHost !== expectedTarget.sshHost) {
            eraseTargetDriftedAfterBackup = true;
            return { confirmed: false };
          }
          if (data.sshHost !== sshFlag.value
            || typeof data.homeServerIdentityId !== 'string' || !data.homeServerIdentityId.trim()
            || typeof data.canonicalServerUrl !== 'string' || !data.canonicalServerUrl.trim()
            || !Array.isArray(data.paths) || paths.length !== data.paths.length || paths.length === 0
            || (data.estimatedBytes !== null && (typeof data.estimatedBytes !== 'number' || !Number.isSafeInteger(data.estimatedBytes) || data.estimatedBytes < 0))) {
            return { confirmed: false };
          }
          if (expectedTarget !== null && (
            data.sshHost !== expectedTarget.sshHost
            || data.canonicalServerUrl !== expectedTarget.canonicalServerUrl
            || data.homeServerIdentityId !== expectedTarget.homeServerIdentityId
            || paths.length !== expectedTarget.paths.length
            || paths.some((path, index) => path !== expectedTarget.paths[index])
          )) {
            eraseTargetDriftedAfterBackup = true;
            return { confirmed: false };
          }
          if (yesFlag.present) return { confirmed: true };
          if (!interactive) return { confirmed: false };
          return { confirmed: await confirmYesNo({
            message: [
              `Confirm ${subcommand} on remote SSH host ${sshFlag.value}?`,
              `Home: ${data.canonicalServerUrl}`,
              `Home identity: ${data.homeServerIdentityId}`,
              ...paths.map((path) => `- ${path}`),
              `Estimated owned bytes: ${data.estimatedBytes === null ? 'unknown' : String(data.estimatedBytes)}`,
            ].join('\n'),
            deps,
            ...(signal ? { signal } : {}),
          }) };
        }
        throw Object.assign(new Error(`Remote Personal Home operation requires unsupported input: ${prompt.kind}`), { code: 'prompt_required' });
      },
    });
    const readRemotePersonalHomeFacts = (value: SystemTaskJsonValue, remoteAction: string): SystemTaskJsonObject => {
      if (!isRecord(value) || value.action !== remoteAction || !isRecord(value.personalHome)) {
        throw Object.assign(new Error('Remote Personal Home operation returned an invalid result.'), { code: 'invalid_cli_response' });
      }
      return value.personalHome;
    };
    if (subcommand === 'erase') {
      const backupOutputPath = await resolvePreEraseBackupOutputPath();
      if (backupOutputPath !== null) {
        const beforeBackup = readRemotePersonalHomeFacts(
          await runRemoteAction('personalHome.status'),
          'personalHome.status',
        );
        const purpose = isRecord(beforeBackup.purpose) ? beforeBackup.purpose : null;
        const identity = isRecord(beforeBackup.identity) ? beforeBackup.identity : null;
        const storage = isRecord(beforeBackup.storage) ? beforeBackup.storage : null;
        const rawPaths = storage?.ownedErasePaths;
        const paths = Array.isArray(rawPaths)
          ? rawPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
          : [];
        const estimatedBytes = storage?.estimatedOwnedBytes;
        if (purpose?.kind !== 'personal-home'
          || typeof purpose.canonicalServerUrl !== 'string' || !purpose.canonicalServerUrl.trim()
          || typeof identity?.homeServerIdentityId !== 'string' || !identity.homeServerIdentityId.trim()
          || !Array.isArray(rawPaths) || paths.length !== rawPaths.length || paths.length === 0
          || (estimatedBytes !== null && (typeof estimatedBytes !== 'number' || !Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0))) {
          throw Object.assign(
            new Error('Remote Personal Home inspection did not resolve the exact erase target; no backup or erase was started.'),
            { code: 'personal_home_inspection_incomplete' },
          );
        }
        remotePreEraseTarget = {
          sshHost: sshFlag.value,
          canonicalServerUrl: purpose.canonicalServerUrl.trim(),
          homeServerIdentityId: identity.homeServerIdentityId.trim(),
          paths,
        };
        const backup = readRemotePersonalHomeFacts(
          await runRemoteAction('personalHome.backup', { outputPath: backupOutputPath }),
          'personalHome.backup',
        );
        if (!json) printSafeFacts(backup, 'Backup');
        const verification = readRemotePersonalHomeFacts(
          await runRemoteAction('personalHome.verifyBackup', { archivePath: backupOutputPath }),
          'personalHome.verifyBackup',
        );
        preEraseVerifiedIdentity = readVerifiedPreEraseBackupIdentity(backup, verification, backupOutputPath);
        if (preEraseVerifiedIdentity !== remotePreEraseTarget.homeServerIdentityId) {
          throw Object.assign(
            new Error('The verified backup identity does not match the inspected remote Personal Home; erase was not started.'),
            { code: 'identity_mismatch' },
          );
        }
      }
    }
    const remoteData = await runRemoteAction(action, personalHomeOperation).catch(failOnEraseTargetDrift);
    if (!isRecord(remoteData) || remoteData.action !== action || !isRecord(remoteData.personalHome)) {
      throw Object.assign(new Error('Remote Personal Home operation returned an invalid result.'), { code: 'invalid_cli_response' });
    }
    if (json) {
      await printJsonEnvelope({ ok: true, kind: 'personal_home_remote_operation', data: remoteData }, { exitCode: 0 });
    } else {
      printSafeFacts(remoteData.personalHome,
        subcommand === 'backup' ? 'Backup' : subcommand === 'restore' ? 'Restore' : subcommand === 'erase' ? 'Erase' : undefined);
    }
    if ((subcommand === 'restore' || subcommand === 'recover-restore')
      && (remoteData.personalHome.outcome === 'rolled_back' || remoteData.personalHome.outcome === 'recovery_required')) {
      throw Object.assign(new Error(`Remote Personal Home ${subcommand} did not complete.`), { code: 'personal_home_restore_incomplete' });
    }
    if (subcommand === 'erase' && remoteData.personalHome.outcome === 'partial') {
      throw Object.assign(new Error('Remote Personal Home erase was only partially completed.'), { code: 'personal_home_erase_incomplete' });
    }
    return;
  }
  const runner = deps.createRunner(runtime);
  let remoteApproval: ReturnType<typeof parseRemotePersonalHomeApprovalInput> | null | undefined;
  const readRemoteApproval = async () => {
    if (remoteApproval !== undefined) return remoteApproval;
    try {
      remoteApproval = parseRemotePersonalHomeApprovalInput(await (deps.readApprovalInput?.() ?? Promise.reject(new Error('Approval input is unavailable.'))));
    } catch {
      remoteApproval = null;
    }
    return remoteApproval;
  };
  const approvalMatches = async (params: Readonly<{
    operation: 'restore' | 'recover-restore' | 'erase';
    canonicalServerUrl: string;
    homeServerIdentityId: string;
    paths: readonly string[];
    estimatedBytes: number | null;
  }>): Promise<boolean> => {
    const approval = await readRemoteApproval();
    return approval !== null
      && approval.operation === params.operation
      && approval.canonicalServerUrl === params.canonicalServerUrl
      && approval.homeServerIdentityId === params.homeServerIdentityId
      && approval.estimatedBytes === params.estimatedBytes
      && approval.paths.length === params.paths.length
      && approval.paths.every((path, index) => path === params.paths[index]);
  };
  const onPrompt = async (prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>): Promise<unknown> => {
    if (prompt.kind !== 'personal_home.confirm_erase.v1') {
      throw Object.assign(new Error(`Unsupported Personal Home task prompt: ${prompt.kind}`), { code: 'prompt_required' });
    }
    const rawPaths = prompt.data.paths;
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const estimatedBytes = prompt.data.estimatedBytes;
    const previewComplete = prompt.data.previewComplete;
    const previewReason = prompt.data.previewReason;
    const canonicalServerUrl = typeof prompt.data.canonicalServerUrl === 'string' ? prompt.data.canonicalServerUrl.trim() : '';
    const homeServerIdentityId = prompt.data.homeServerIdentityId === null
      || (typeof prompt.data.homeServerIdentityId === 'string' && prompt.data.homeServerIdentityId.trim().length > 0)
      ? prompt.data.homeServerIdentityId
      : undefined;
    if (!Array.isArray(rawPaths)
      || paths.length !== rawPaths.length
      || paths.length === 0
      || !canonicalServerUrl
      || homeServerIdentityId === undefined
      || previewComplete !== true
      || previewReason !== null
      || (estimatedBytes !== null && (typeof estimatedBytes !== 'number' || !Number.isFinite(estimatedBytes) || estimatedBytes < 0))) {
      return { confirmed: false };
    }
    if (preEraseVerifiedIdentity !== null && homeServerIdentityId !== preEraseVerifiedIdentity) {
      eraseTargetDriftedAfterBackup = true;
      return { confirmed: false };
    }
    const verifiedBackupPath = verifiedLocalPreEraseBackupPath;
    if (verifiedBackupPath !== null
      && paths.some((owned) => isHappierRuntimePathWithinRoot(verifiedBackupPath, owned))) {
      eraseTargetDriftedAfterBackup = true;
      return { confirmed: false };
    }
    if (approvalStdinFlag.present) {
      return { confirmed: typeof homeServerIdentityId === 'string' && await approvalMatches({
        operation: 'erase', canonicalServerUrl, homeServerIdentityId, paths, estimatedBytes,
      }) };
    }
    if (yesFlag.present) return { confirmed: true };
    if (!interactive) return { confirmed: false };
    return { confirmed: await confirmYesNo({
      message: [
        'Permanently erase the owner-validated Personal Home paths below?',
        `Home: ${canonicalServerUrl}`,
        `Home identity: ${homeServerIdentityId ?? 'unavailable'}`,
        ...paths.map((path) => `- ${path}`),
        `Estimated owned bytes: ${estimatedBytes === null ? 'unknown' : String(estimatedBytes)}`,
      ].join('\n'),
      deps,
      ...(signal ? { signal } : {}),
    }) };
  };
  const purpose = await readPersonalHomePurpose({ runner, signal, sleep: deps.sleep, runtime });
  const run = async (
    spec: SystemTaskSpec,
    visible = true,
    operation?: PersonalHomeOperationLabel,
    projectData?: (data: SystemTaskJsonValue) => SystemTaskJsonValue,
  ): Promise<SystemTaskJsonValue> => {
    const data = await runTask({ runner, spec, json, visible, signal, sleep: deps.sleep, onPrompt, projectData });
    if (visible && !json) printSafeFacts(data, operation);
    return data;
  };

  if (subcommand === 'relocation-destination') {
    const action = args[0];
    args = args.slice(1);
    const operationIdFlag = takeFlagValue(args, '--operation-id');
    args = operationIdFlag.rest;
    const operationId = operationIdFlag.value?.trim() ?? '';
    if (!operationId) throw new Error('Relocation destination operation requires --operation-id.');
    if (action === 'status' || action === 'abort') {
      if (args.length > 0) throw new Error(`Unknown relocation destination ${action} arguments: ${args.join(' ')}`);
      await run(taskSpec(
        action === 'status'
          ? PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStatus
          : PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationAbort,
        purpose,
        runtime,
        { operationId },
      ));
      return;
    }
    if (action === 'stage') {
      const archiveFlag = takeFlagValue(args, '--archive');
      const prepareUploadFlag = takeFlag(archiveFlag.rest, '--prepare-upload');
      if (prepareUploadFlag.present) {
        if (archiveFlag.value !== null || prepareUploadFlag.rest.length > 0) {
          throw new Error('Relocation upload preparation accepts only --operation-id and --prepare-upload.');
        }
        const prepared = await (deps.prepareRelocationUpload ?? preparePersonalHomeRelocationUpload)({ operationId });
        await writeJsonStdout({
          kind: 'personal_home_task_result',
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          result: {
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: `relocation-upload:${operationId}`,
            ok: true,
            data: { operationId: prepared.operationId, uploadLocator: prepared.uploadLocator },
          },
        });
        return;
      }
      const digestFlag = takeFlagValue(prepareUploadFlag.rest, '--bundle-sha256');
      const homeIdFlag = takeFlagValue(digestFlag.rest, '--expected-home-id');
      const canonicalUrlFlag = takeFlagValue(homeIdFlag.rest, '--expected-canonical-server-url');
      const revisionFlag = takeFlagValue(canonicalUrlFlag.rest, '--source-descriptor-revision');
      if (revisionFlag.rest.length > 0) throw new Error(`Unknown relocation destination stage arguments: ${revisionFlag.rest.join(' ')}`);
      const sourceDescriptorRevision = Number(revisionFlag.value);
      if (!Number.isSafeInteger(sourceDescriptorRevision) || sourceDescriptorRevision < 1) {
        throw new Error('Relocation destination stage requires a positive --source-descriptor-revision.');
      }
      const stageParams = {
        operationId,
        bundleSha256: digestFlag.value ?? '',
        expectedHomeServerIdentityId: homeIdFlag.value ?? '',
        expectedCanonicalServerUrl: canonicalUrlFlag.value ?? '',
        sourceDescriptorRevision,
      };
      if (archiveFlag.value !== null) {
        await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStage, purpose, runtime, {
          ...stageParams,
          archivePath: requirePath(archiveFlag.value, 'relocation bundle path', deps),
        }));
        return;
      }
      let data: SystemTaskJsonValue | undefined;
      let stageError: unknown;
      let cleanupNeedsAttention = false;
      try {
        // Consumption and the stage task both own the reserved destination-side
        // transfer directory; the exact reservation is cleaned even when either
        // fails.
        const { archivePath } = await (deps.consumeRelocationUpload ?? consumePersonalHomeRelocationUpload)({
          operationId,
        });
        data = await runTask({
          runner,
          spec: taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStage, purpose, runtime, {
            ...stageParams,
            archivePath,
          }),
          json: false,
          visible: false,
          signal,
          sleep: deps.sleep,
          onPrompt,
        });
      } catch (error) {
        stageError = error;
      } finally {
        try {
          await (deps.cleanupRelocationUpload ?? cleanupPersonalHomeRelocationUpload)({ operationId });
        } catch {
          cleanupNeedsAttention = true;
        }
      }
      if (stageError !== undefined) {
        if (cleanupNeedsAttention) throw new PersonalHomeRelocationTransferCleanupError(stageError);
        throw stageError;
      }
      if (data === undefined) throw new Error('Relocation destination stage returned no result.');
      const resultData = cleanupNeedsAttention && isRecord(data)
        ? { ...data, transferCleanupNeedsAttention: true }
        : data;
      await writeJsonStdout({
        kind: 'personal_home_task_result',
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        result: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          taskId: `relocation-stage:${operationId}`,
          ok: true,
          data: resultData,
        },
      });
      return;
    }
    if (action === 'commit') {
      const descriptorFlag = takeFlagValue(args, '--published-descriptor-json');
      if (descriptorFlag.rest.length > 0) throw new Error(`Unknown relocation destination commit arguments: ${descriptorFlag.rest.join(' ')}`);
      let publishedDescriptor: SystemTaskJsonValue;
      try {
        publishedDescriptor = SystemTaskJsonValueSchema.parse(JSON.parse(descriptorFlag.value ?? ''));
      } catch {
        throw new Error('Relocation destination commit requires valid --published-descriptor-json.');
      }
      await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationCommit, purpose, runtime, {
        operationId,
        publishedDescriptor,
      }));
      return;
    }
    throw new Error('Usage: happier home relocation-destination <stage|status|commit|abort> --operation-id ID ... --json');
  }

  if (subcommand === 'status') {
    if (args.length > 0) throw new Error(`Unknown home status arguments: ${args.join(' ')}`);
    await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect, purpose, runtime), true, undefined, (data) => (
      isRecord(data) ? { ...data, purpose } : data
    ));
    return;
  }

  if (subcommand === 'backup') {
    const output = takeFlagValue(args, '--output');
    args = output.rest;
    if (args.length > 0) throw new Error(`Unknown home backup arguments: ${args.join(' ')}`);
    const outputPath = output.value === null ? null : requirePath(output.value, 'backup output path', deps);
    await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.backup, purpose, runtime, outputPath ? { outputPath } : {}), true, 'Backup');
    return;
  }

  if (subcommand === 'verify-backup') {
    if (args.length !== 1) throw new Error('Usage: happier home verify-backup PATH');
    const archivePath = requirePath(args[0], 'backup archive path', deps);
    await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup, purpose, runtime, { archivePath }));
    return;
  }

  if (subcommand === 'restore') {
    if (args.length !== 1) throw new Error('Usage: happier home restore PATH [--yes]');
    const archivePath = requirePath(args[0], 'backup archive path', deps);
    const inspection = await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect, purpose, runtime));
    const destinationEmpty = isRecord(inspection)
      && isRecord(inspection.storage)
      && inspection.storage.destinationEmpty === true;
    const destinationNonEmpty = isRecord(inspection)
      && isRecord(inspection.storage)
      && inspection.storage.destinationEmpty === false;
    if (!destinationEmpty && !destinationNonEmpty) {
      throw Object.assign(new Error('Personal Home inspection did not establish whether the restore destination is empty.'), { code: 'personal_home_inspection_incomplete' });
    }
    const verification = await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup, purpose, runtime, { archivePath }));
    if (!isRecord(verification) || !isRecord(verification.manifest)) {
      throw Object.assign(new Error('Backup verification did not return a valid manifest; restore was not started.'), { code: 'invalid_backup_manifest' });
    }
    if (verification.identityMatchesCurrentHome === 'mismatch'
      || (verification.identityMatchesCurrentHome !== 'match' && !destinationEmpty)) {
      throw Object.assign(new Error('Backup identity does not match this Personal Home; restore was not started.'), { code: 'identity_mismatch' });
    }
    if (verification.manifest.format !== 'happier-personal-home-backup' || verification.manifest.version !== 1) {
      throw Object.assign(new Error('Backup schema is unsupported; restore was not started.'), { code: 'unsupported_backup_schema' });
    }
    if (destinationNonEmpty) {
      const identity = isRecord(inspection.identity) && typeof inspection.identity.homeServerIdentityId === 'string'
        ? inspection.identity.homeServerIdentityId
        : '';
      const paths = isRecord(inspection.storage) && Array.isArray(inspection.storage.ownedErasePaths)
        ? inspection.storage.ownedErasePaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        : [];
      const estimatedBytes = isRecord(inspection.storage)
        && (inspection.storage.estimatedOwnedBytes === null || typeof inspection.storage.estimatedOwnedBytes === 'number')
        ? inspection.storage.estimatedOwnedBytes
        : null;
      const remotelyApproved = approvalStdinFlag.present && identity && paths.length > 0
        ? await approvalMatches({
            operation: 'restore', canonicalServerUrl: purpose.canonicalServerUrl,
            homeServerIdentityId: identity, paths, estimatedBytes,
          })
        : false;
      if (approvalStdinFlag.present && !remotelyApproved) {
        throw Object.assign(new Error('Remote restore approval no longer matches the current Personal Home.'), { code: 'confirmation_required' });
      }
      if (!remotelyApproved) {
        await confirmDestructive({
          yes: yesFlag.present,
          interactive: deps.isInteractiveTerminal() && !json,
          prompt: 'Restore this verified backup and overwrite the current Personal Home data?',
          nonInteractiveMessage: 'Non-interactive restore into a non-empty Personal Home requires --yes after successful backup verification.',
          deps,
          ...(signal ? { signal } : {}),
        });
      }
    }
    const expectedHomeServerIdentityId = typeof verification.manifest.homeServerIdentityId === 'string'
      ? verification.manifest.homeServerIdentityId
      : '';
    if (!expectedHomeServerIdentityId) throw Object.assign(new Error('Verified backup is missing its Home identity.'), { code: 'invalid_backup_manifest' });
    const result = await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.restore, purpose, runtime, {
      archivePath,
      ...(destinationNonEmpty ? { confirmOverwrite: true } : {}),
      expectedHomeServerIdentityId,
    }), true, 'Restore');
    if (isRecord(result) && (result.outcome === 'rolled_back' || result.outcome === 'recovery_required')) {
      throw Object.assign(
        new Error(result.error === undefined
          ? `Personal Home restore did not complete (${result.outcome}).`
          : `Personal Home restore did not complete (${result.outcome}): ${String(result.error)}`),
        { code: 'personal_home_restore_incomplete', personalHomeTaskFailure: true },
      );
    }
    return;
  }

  if (subcommand === 'recover-restore') {
    if (args.length > 0) throw new Error(`Unknown home recover-restore arguments: ${args.join(' ')}`);
    const inspection = await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect, purpose, runtime));
    const { status, affectedTargets } = readRestoreRecoveryFacts(inspection);
    if (status === 'none') {
      if (!json) console.log('No interrupted Personal Home restore needs recovery.');
      return;
    }
    if (status === 'ambiguous') {
      throw Object.assign(new Error(`Restore recovery is ambiguous. Repair is required before mutation. Affected targets: ${affectedTargets.join(', ') || 'unknown'}`), { code: 'restore_recovery_ambiguous' });
    }
    if (status !== 'rollback_available' || affectedTargets.length === 0) {
      throw Object.assign(new Error('Personal Home inspection returned an invalid restore recovery state.'), { code: 'personal_home_inspection_incomplete' });
    }
    if (!json) console.log(['Restore rollback is available for:', ...affectedTargets.map((target) => `- ${target}`)].join('\n'));
    const inspectionRecord = isRecord(inspection) ? inspection : null;
    const recoveryIdentity = isRecord(inspectionRecord?.identity) && typeof inspectionRecord.identity.homeServerIdentityId === 'string'
      ? inspectionRecord.identity.homeServerIdentityId
      : '';
    const recoveryBytes = isRecord(inspectionRecord?.storage)
      && (inspectionRecord.storage.estimatedOwnedBytes === null || typeof inspectionRecord.storage.estimatedOwnedBytes === 'number')
      ? inspectionRecord.storage.estimatedOwnedBytes
      : null;
    const remotelyApproved = approvalStdinFlag.present && recoveryIdentity
      ? await approvalMatches({
          operation: 'recover-restore', canonicalServerUrl: purpose.canonicalServerUrl,
          homeServerIdentityId: recoveryIdentity, paths: affectedTargets, estimatedBytes: recoveryBytes,
        })
      : false;
    if (approvalStdinFlag.present && !remotelyApproved) {
      throw Object.assign(new Error('Remote restore-recovery approval no longer matches the current Personal Home.'), { code: 'confirmation_required' });
    }
    if (!remotelyApproved) {
      await confirmDestructive({
        yes: yesFlag.present,
        interactive,
        prompt: 'Roll back the interrupted restore using the retained recovery material?',
        nonInteractiveMessage: 'Non-interactive restore recovery requires --yes.',
        deps,
        ...(signal ? { signal } : {}),
      });
    }
    await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.restore, purpose, runtime, { action: 'recover' }));
    return;
  }

  if (subcommand === 'erase') {
    if (args.length > 0) {
      throw Object.assign(new Error(`Unknown home erase arguments: ${args.join(' ')}`), { code: 'invalid_params' });
    }
    const backupOutputPath = await resolvePreEraseBackupOutputPath();
    if (backupOutputPath !== null) {
      const inspection = await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect, purpose, runtime));
      const ownedErasePaths = isRecord(inspection) && isRecord(inspection.storage) && Array.isArray(inspection.storage.ownedErasePaths)
        ? inspection.storage.ownedErasePaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        : [];
      if (ownedErasePaths.length === 0) {
        throw Object.assign(
          new Error('Personal Home inspection did not resolve the erase target paths; no backup or erase was started.'),
          { code: 'personal_home_inspection_incomplete' },
        );
      }
      // A backup written inside the erased data would be deleted by this very operation,
      // so the destination is validated against the owner's exact target set first.
      if (ownedErasePaths.some((owned) => isHappierRuntimePathWithinRoot(backupOutputPath, owned))) {
        throw Object.assign(
          new Error(`The pre-erase backup destination is inside the Personal Home data this erase deletes: ${backupOutputPath}`),
          { code: 'backup_output_required' },
        );
      }
      const backup = await run(
        taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.backup, purpose, runtime, { outputPath: backupOutputPath }),
        true,
        'Backup',
      );
      const verification = await run(
        taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup, purpose, runtime, { archivePath: backupOutputPath }),
      );
      const verifiedIdentity = readVerifiedPreEraseBackupIdentity(backup, verification, backupOutputPath);
      const refreshed = await readPersonalHomePurpose({ runner, signal, sleep: deps.sleep, runtime });
      if (refreshed.canonicalServerUrl !== purpose.canonicalServerUrl) {
        throw Object.assign(
          new Error('The managed Personal Home changed after the verified backup; nothing was erased.'),
          { code: 'identity_mismatch' },
        );
      }
      preEraseVerifiedIdentity = verifiedIdentity;
      verifiedLocalPreEraseBackupPath = backupOutputPath;
    }
    const result = await run(taskSpec(PERSONAL_HOME_SYSTEM_TASK_KINDS.erase, purpose, runtime), true, 'Erase')
      .catch(failOnEraseTargetDrift);
    if (isRecord(result) && result.outcome === 'partial') {
      throw Object.assign(
        new Error(result.error === undefined
          ? 'Personal Home erase was only partially completed.'
          : `Personal Home erase was only partially completed: ${String(result.error)}`),
        { code: 'personal_home_erase_incomplete', personalHomeTaskFailure: true },
      );
    }
    return;
  }

  throw new Error(`Unknown home subcommand: ${subcommand}`);
}

function parseRemotePersonalHomeCreateTaskData(
  value: SystemTaskJsonValue,
): Omit<PersonalHomeCreateResult, 'channel' | 'mode' | 'accountServiceLink' | 'invokingClientEnrollment' | 'pairing'> & Readonly<{
  pairing: RemoteHomePairingResult;
  invokingClientEnrollment: Readonly<{ kind: 'enrolled' | 'failed' | 'not_requested' }>;
}> {
  if (!isRecord(value) || value.action !== 'personalHome.create' || !isRecord(value.personalHome)) {
    throw Object.assign(new Error('Remote Personal Home task returned an invalid result.'), { code: 'invalid_cli_response' });
  }
  const data = value.personalHome;
  const descriptor = HomeConnectionDescriptorV1Schema.safeParse(data.descriptor);
  const pairing = parseRemoteHomePairingResult(data.pairing);
  const invokingClientEnrollment = parseRemoteInvokingClientEnrollmentResult(data.invokingClientEnrollment);
  if (data.status !== 'complete'
    || typeof data.homeServerIdentityId !== 'string'
    || typeof data.canonicalServerUrl !== 'string'
    || typeof data.accountCreated !== 'boolean'
    || !descriptor.success
    || !pairing
    || !invokingClientEnrollment
    || descriptor.data.homeServerIdentityId !== data.homeServerIdentityId
    || descriptor.data.canonicalServerUrl !== data.canonicalServerUrl) {
    throw Object.assign(new Error('Remote Personal Home task returned invalid identity or descriptor facts.'), { code: 'invalid_cli_response' });
  }
  return {
    status: 'complete',
    homeServerIdentityId: data.homeServerIdentityId,
    canonicalServerUrl: data.canonicalServerUrl,
    accountCreated: data.accountCreated,
    descriptor: descriptor.data,
    pairing,
    invokingClientEnrollment,
  };
}

function parseRemoteHomePairingResult(value: unknown): RemoteHomePairingResult | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if ((value.kind === 'not_requested' || value.kind === 'cancelled' || value.kind === 'expired'
    || value.kind === 'invalid_request' || value.kind === 'update_required')
    && Object.keys(value).length === 1) {
    return { kind: value.kind };
  }
  if (value.kind === 'completed'
    && Object.keys(value).length === 2
    && Object.hasOwn(value, 'requestedDeviceLabel')
    && (value.requestedDeviceLabel === null || typeof value.requestedDeviceLabel === 'string')) {
    return { kind: 'completed', requestedDeviceLabel: value.requestedDeviceLabel };
  }
  if (value.kind === 'failed'
    && Object.keys(value).length === 2
    && Number.isInteger(value.status)
    && Number(value.status) >= 0) {
    return { kind: 'failed', status: Number(value.status) };
  }
  return null;
}

function parseRemoteInvokingClientEnrollmentResult(
  value: unknown,
): Readonly<{ kind: 'enrolled' | 'failed' | 'not_requested' }> | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  return value.kind === 'enrolled' || value.kind === 'failed' || value.kind === 'not_requested'
    ? { kind: value.kind }
    : null;
}

export async function handleHomeCliCommand(
  context: CommandContext,
  deps: HomeCommandDeps = DEFAULT_DEPS,
): Promise<void> {
  const json = wantsJson(context.args);
  try {
    await handleHomeCommand(context.args.slice(1), deps, context.signal);
  } catch (error) {
    const errorRecord = isRecord(error) ? error : null;
    const rawCode = typeof errorRecord?.code === 'string' ? errorRecord.code : null;
    const expectedHomeCodes = new Set([
      'cancelled',
      'purpose_not_personal_home',
      'personal_home_status_incomplete',
      'confirmation_required',
      'confirmation_declined',
      'interactive_required',
      'identity_mismatch',
      'unsupported_backup_schema',
      'invalid_backup_manifest',
      'invalid_backup_result',
      'backup_output_required',
      'personal_home_inspection_incomplete',
      'personal_home_restore_incomplete',
      'personal_home_erase_incomplete',
      'home_create_reconciliation_failed',
      'restore_recovery_ambiguous',
      'invalid_runtime_target',
      'invalid_params',
      'pair_device_unavailable',
      'link_account_unavailable',
      'pairing_expired',
      'update_required',
      'invalid_pairing_request',
      'pairing_failed',
      'relink_required',
      'home_profile_unavailable',
      'home_credentials_unavailable',
      'account_service_credentials_unavailable',
      'home_transport_unavailable',
      'link_account_failed',
    ]);
    const mapped = rawCode && (errorRecord?.personalHomeTaskFailure === true || expectedHomeCodes.has(rawCode))
      ? { code: rawCode, unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) }
      : mapUnknownErrorToControlError(error);
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'personal_home_operation',
        error: {
          code: mapped.code,
          ...(mapped.message ? { message: mapped.message } : {}),
          ...(rawCode === 'personal_home_relocation_incomplete'
            && errorRecord?.status === 'pending'
            && (errorRecord.recoveryAction === 'finish_move' || errorRecord.recoveryAction === 'return_to_source')
            ? { status: errorRecord.status, recoveryAction: errorRecord.recoveryAction }
            : {}),
        },
      }, { exitCode: mapped.unexpected ? 2 : 1 });
      return;
    }
    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}

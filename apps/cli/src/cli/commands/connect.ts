import { type ConnectTarget, localizedText, sameService, exactServiceCommandId, legacyServiceIdFor, projectConnectTargets, printConnectHelp } from './connect/help';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { PluginConnectedAccountAuthenticationModeV2, PluginConnectedAccountDescriptorContributionV2, PluginContributionIdentityV1, PluginJsonValueV2, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import {
  banner,
  bullets,
  cmd,
  createStepPrinter,
  dim,
  errorFrame,
  gray,
  neutral,
  ok,
  sectionTitle,
  warn,
} from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { configuration } from '@/configuration';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';
import { readStoredCredentials } from '@/persistence';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { openBrowser } from '@/ui/openBrowser';
import { delay } from '@/utils/time';

import {
  createConnectedAccountDaemonClient,
  type ConnectedAccountDaemonClient,
} from './connect/connectedAccountDaemonClient';
import { parseConnectArgs, type ConnectParsedOptions } from './connect/parseConnectArgs';
import { resolveConnectNativeImportIntent } from './connect/resolveConnectNativeImportIntent';

type AttemptResponse = Awaited<
  ReturnType<ConnectedAccountDaemonClient['authenticate']>
>;
type ControlResponse = Awaited<
  ReturnType<ConnectedAccountDaemonClient['control']>
>;
type DescribedService = Extract<ControlResponse, { status: 'described' }>;
type ConfigurationDescription = Extract<
  ControlResponse,
  { status: 'configuration' }
>;
type ConfigurationTarget = ConfigurationDescription['target'];
type ManualField = Extract<
  PluginConnectedAccountAuthenticationModeV2,
  { kind: 'manual' }
>['fields'][number];
type ConfigurationField = Readonly<{
  id: string;
  title: string | Readonly<{ fallback: string }>;
  schema: Readonly<{
    type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
    enum?: readonly unknown[];
    const?: unknown;
  }>;
  secret: boolean;
  default?: unknown;
  required?: boolean;
  presentation?: Readonly<{
    hidden?: boolean;
    order?: number;
  }>;
}>;


type AuthenticationIntent =
  | Readonly<{
      kind: 'connect';
      service: PluginContributionIdentityV1;
      modeId: string;
    }>
  | Readonly<{
      kind: 'reconnect';
      account: Readonly<{
        service: PluginContributionIdentityV1;
        accountId: string;
      }>;
    }>;






async function loadConnectTargets(client: ConnectedAccountDaemonClient): Promise<readonly ConnectTarget[]> {
  const registry = await client.readContributions();
  return projectConnectTargets({ connectedAccountDescriptors: (registry.connectedAccountDescriptors ?? []).flatMap((contribution) => {
    const parsed = PluginConnectedAccountDescriptorContributionV2Schema.safeParse(contribution.definition);
    return parsed.success ? [{ ...contribution, definition: parsed.data }] : [];
  }) });
}


function findTarget(
  targets: readonly ConnectTarget[],
  commandId: string,
): ConnectTarget | null {
  const normalized = commandId.trim().toLowerCase();
  const matches = targets.filter((target) =>
    target.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
  return matches.length === 1 ? matches[0]! : null;
}

async function createDaemonClient(signal?: AbortSignal, yes = false): Promise<ConnectedAccountDaemonClient> {
  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new Error(
      `Not authenticated with Happier. Run ${cmd('happier auth login')} first.`,
    );
  }
  const { machineId } = await ensureMachineIdForCredentials(credentials);
  let confirmed = yes;
  return createConnectedAccountDaemonClient({ credentials, machineId, ...(signal ? { signal } : {}),
    onApprovalRequested: async (artifactId, confirmationSignal, decide) => {
      console.error(`Waiting for approval: ${artifactId}`);
      let approve = confirmed;
      if (!approve) {
        try {
          approve = await promptConfirmYesNo('Approve this connected-account operation?', {
            default: 'no', signal: confirmationSignal,
          });
        } catch (error) {
          // EOF or an unavailable terminal declines consent. A decision from
          // another surface instead aborts this prompt through the wait owner.
          if (confirmationSignal.aborted) throw error;
        }
      }
      // This command owns one initiated Connect flow. Its confirmation covers
      // the configuration/save steps, while every Artifact decision still goes
      // through the canonical authority and explicit Ask policy.
      confirmed = approve;
      const result = await decide(approve ? 'approve' : 'reject');
      if (!result.ok) throw Object.assign(new Error(result.errorCode ?? result.error), { code: result.errorCode });
      return result;
    },
  });
}

function modeSelectedByFlags(
  described: DescribedService,
  target: ConnectTarget,
  options: ConnectParsedOptions,
): PluginConnectedAccountAuthenticationModeV2 {
  const modes = described.descriptor.authentication.modes;
  const explicitKinds = [
    options.device ? 'oauthDeviceCode' : null,
    options.oauth || options.paste ? 'oauthAuthorizationCode' : null,
  ].filter((kind): kind is PluginConnectedAccountAuthenticationModeV2['kind'] =>
    kind !== null,
  );
  if (explicitKinds.length > 1) {
    throw new Error('Choose only one authentication-mode flag.');
  }

  let modeId = options.modeId;
  if (!modeId && explicitKinds[0]) {
    modeId = modes.find((mode) => mode.kind === explicitKinds[0])?.id ?? null;
  }
  if (
    !modeId &&
    (options.token || options.apiKey || options.setupToken)
  ) {
    const legacyServiceId = legacyServiceIdFor(target.service);
    const compatibility = legacyServiceId
      ? BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
          legacyServiceId as keyof typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID
        ]
      : null;
    const tokenModeId =
      compatibility &&
      'token' in compatibility.authenticationModeByCredentialKind
        ? compatibility.authenticationModeByCredentialKind.token
        : undefined;
    modeId =
      tokenModeId ??
      modes.find((mode) => mode.kind === 'manual')?.id ??
      null;
  }
  modeId ??= described.descriptor.authentication.defaultModeId;
  const selected = modes.find((mode) => mode.id === modeId);
  if (!selected) {
    throw new Error(
      `Authentication mode '${modeId}' is not declared by ${target.commandId}.`,
    );
  }
  if (explicitKinds[0] && selected.kind !== explicitKinds[0]) {
    throw new Error(
      `${target.commandId} does not declare the requested authentication mode.`,
    );
  }
  return selected;
}

function validateManualString(
  field: ManualField,
  value: string,
): boolean {
  const schema = field.schema;
  if (schema.type !== undefined && schema.type !== 'string') return false;
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return false;
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    return false;
  }
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && schema.const !== value) return false;
  if (schema.pattern !== undefined) {
    try {
      if (!new RegExp(schema.pattern).test(value)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function promptManualFields(
  mode: Extract<
    PluginConnectedAccountAuthenticationModeV2,
    { kind: 'manual' }
  >,
): Promise<Readonly<Record<string, string>>> {
  const values: Record<string, string> = {};
  const fields = [...mode.fields].sort((left, right) => {
    const order =
      (left.presentation?.order ?? Number.POSITIVE_INFINITY) -
      (right.presentation?.order ?? Number.POSITIVE_INFINITY);
    return order || left.id.localeCompare(right.id);
  });
  for (const field of fields) {
    const title = localizedText(field.title) || field.id;
    const value = (
      field.secret === true
        ? await promptSecretInput(`${title}: `)
        : await promptInput(`${title}: `)
    ).trim();
    if (!validateManualString(field, value)) {
      throw new Error(`Invalid value for '${field.id}'.`);
    }
    values[field.id] = value;
  }
  return Object.freeze(values);
}

function formatJsonValue(value: PluginJsonValueV2 | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseConfigurationValue(
  field: ConfigurationField,
  rawValue: string,
): PluginJsonValueV2 {
  const schema = field.schema;
  let value: PluginJsonValueV2;
  switch (schema.type) {
    case 'boolean': {
      const normalized = rawValue.trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(normalized)) value = true;
      else if (['false', 'no', 'n', '0'].includes(normalized)) value = false;
      else throw new Error(`Invalid boolean for '${field.id}'.`);
      break;
    }
    case 'number':
    case 'integer': {
      const parsed = Number(rawValue);
      if (
        !Number.isFinite(parsed) ||
        (schema.type === 'integer' && !Number.isInteger(parsed))
      ) {
        throw new Error(`Invalid number for '${field.id}'.`);
      }
      value = parsed;
      break;
    }
    case 'array':
    case 'object':
    case 'null': {
      try {
        value = JSON.parse(rawValue) as PluginJsonValueV2;
      } catch {
        throw new Error(`Invalid JSON for '${field.id}'.`);
      }
      break;
    }
    default:
      value = rawValue;
  }
  if (
    schema.enum &&
    !schema.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    )
  ) {
    throw new Error(`Value for '${field.id}' is not an allowed option.`);
  }
  if (
    schema.const !== undefined &&
    JSON.stringify(schema.const) !== JSON.stringify(value)
  ) {
    throw new Error(`Value for '${field.id}' does not match its fixed value.`);
  }
  return value;
}

function normalizeConfigurationJsonValue(value: unknown): PluginJsonValueV2 {
  return PluginJsonValueV2Schema.parse(value);
}

async function promptConfiguration(
  description: ConfigurationDescription,
): Promise<
  Readonly<{
    values: Readonly<Record<string, PluginJsonValueV2>>;
    secretValues: Readonly<Record<string, string>>;
  }>
> {
  const configuration =
    'configuration' in description.mode
      ? description.mode.configuration
      : undefined;
  if (!configuration) {
    throw new Error('Daemon requested undeclared connected-account configuration.');
  }
  const values: Record<string, PluginJsonValueV2> = {};
  const secretValues: Record<string, string> = {};
  const configuredSecretFieldIds = new Set(
    description.configuration.configuredSecretFieldIds,
  );
  const fields = [...configuration.fields].sort((left, right) => {
    const order =
      (left.presentation?.order ?? Number.POSITIVE_INFINITY) -
      (right.presentation?.order ?? Number.POSITIVE_INFINITY);
    return order || left.id.localeCompare(right.id);
  });

  for (const field of fields) {
    const current = description.configuration.values[field.id] ?? field.default;
    if (field.presentation?.hidden === true) {
      if (field.secret === true) {
        if (field.required === true && !configuredSecretFieldIds.has(field.id)) {
          throw new Error(`Missing required hidden secret '${field.id}'.`);
        }
      } else if (current !== undefined) {
        values[field.id] = normalizeConfigurationJsonValue(current);
      } else if (field.required === true) {
        throw new Error(`Missing required hidden value '${field.id}'.`);
      }
      continue;
    }
    const title = localizedText(field.title) || field.id;
    if (field.secret === true) {
      const secret = await promptSecretInput(
        `${title}${configuredSecretFieldIds.has(field.id) ? ' (blank keeps current)' : ''}: `,
      );
      if (secret.length > 0) {
        secretValues[field.id] = secret;
      } else if (
        field.required === true &&
        !configuredSecretFieldIds.has(field.id)
      ) {
        throw new Error(`Missing required configuration '${field.id}'.`);
      }
      continue;
    }
    const currentText = formatJsonValue(
      current === undefined
        ? undefined
        : normalizeConfigurationJsonValue(current),
    );
    const input = await promptInput(
      `${title}${currentText ? ` [${currentText}]` : ''}: `,
    );
    const selected = input.length > 0 ? input : currentText;
    if (!selected) {
      if (field.required === true) {
        throw new Error(`Missing required configuration '${field.id}'.`);
      }
      continue;
    }
    values[field.id] = parseConfigurationValue(field, selected);
  }
  return Object.freeze({
    values: Object.freeze(values),
    secretValues: Object.freeze(secretValues),
  });
}

function toControlTarget(
  target: ConfigurationTarget,
): Parameters<ConnectedAccountDaemonClient['control']>[0] extends infer _T
  ? Extract<
      Parameters<ConnectedAccountDaemonClient['control']>[0],
      { operation: 'readConfiguration' }
    >['target']
  : never {
  switch (target.kind) {
    case 'service':
      return target;
    case 'account':
      return { kind: 'account', account: target.account };
    case 'attempt':
      return { kind: 'attempt', attemptId: target.attemptId };
  }
}

async function replaceRequiredConfiguration(params: Readonly<{
  client: ConnectedAccountDaemonClient;
  response: Extract<AttemptResponse, { status: 'configurationRequired' }>;
}>): Promise<string | undefined> {
  const read = await params.client.control({
    operation: 'readConfiguration',
    target: toControlTarget(params.response.target),
  });
  if (read.status !== 'configuration') {
    throw new Error(
      `Connected-account configuration unavailable (${controlFailureCode(read)}).`,
    );
  }
  const replacement = await promptConfiguration(read);
  const committed = await params.client.control({
    operation: 'replaceConfiguration',
    target: toControlTarget(read.target),
    expectedRevision: read.configuration.revision,
    values: replacement.values,
    secretValues: replacement.secretValues,
  });
  if (committed.status !== 'configurationCommitted') {
    throw new Error(
      `Connected-account configuration was not committed (${controlFailureCode(committed)}).`,
    );
  }
  return committed.configuration.revision ?? undefined;
}

function describeFailure(response: AttemptResponse): string {
  if ('code' in response) return response.code;
  return `connected_account_${response.status}`;
}

function controlFailureCode(response: ControlResponse): string {
  return 'code' in response
    ? response.code
    : `connected_account_control_${response.status}_unexpected`;
}

export async function continueConnectedAccountAuthentication(params: Readonly<{
  client: ConnectedAccountDaemonClient;
  described: DescribedService;
  intent: AuthenticationIntent;
  initial: AttemptResponse;
  options: ConnectParsedOptions;
  nativeImportFields?: Readonly<{ source: string }>;
  signal?: AbortSignal;
}>): Promise<Extract<AttemptResponse, { status: 'connected' }>> {
  const startedAt = Date.now();
  const timeoutMs = (params.options.timeoutSeconds ?? 10 * 60) * 1000;
  let response = params.initial;
  let renderedDeviceAttemptId: string | null = null;
  // One step spans the whole device-code wait (every poll), from the printed code to the daemon's answer.
  const steps = createStepPrinter();
  let waiting = false;
  const leaveWaiting = () => {
    if (!waiting) return;
    waiting = false;
    steps.pause();
  };
  const resolveAuthenticationMode = () => {
    const reconnectAccount =
      params.intent.kind === 'reconnect' ? params.intent.account : null;
    const authenticationModeId =
      params.intent.kind === 'connect'
        ? params.intent.modeId
        : params.described.accounts.find(
            (account) =>
              reconnectAccount !== null &&
              account.ref.accountId === reconnectAccount.accountId &&
              sameService(
                account.ref.service,
                reconnectAccount.service,
              ),
          )?.authenticationModeId;
    return params.described.descriptor.authentication.modes.find(
      (candidate) => candidate.id === authenticationModeId,
    );
  };

  try {
    for (let step = 0; step < 1_000; step += 1) {
      params.signal?.throwIfAborted();
      if (Date.now() - startedAt > timeoutMs) {
        if ('attemptId' in response && response.attemptId) {
          await params.client
            .authenticate({ operation: 'cancel', attemptId: response.attemptId })
            .catch(() => undefined);
        }
        throw new Error('Connected-account authentication timed out.');
      }
      switch (response.status) {
        case 'starting':
          await delay(100);
          response = await params.client.authenticate({
            operation: 'read',
            attemptId: response.attemptId,
          });
          break;
        case 'awaitingManual': {
          leaveWaiting();
          const mode = resolveAuthenticationMode();
          if (!mode || mode.kind !== 'manual') {
            throw new Error('Daemon returned an undeclared manual authentication phase.');
          }
          response = await params.client.authenticate({
            operation: 'submitManual',
            attemptId: response.attemptId,
            fields: params.nativeImportFields ?? await promptManualFields(mode),
          });
          break;
        }
        case 'awaitingOAuth': {
          leaveWaiting();
          const mode = resolveAuthenticationMode();
          if (!mode || mode.kind !== 'oauthAuthorizationCode') {
            throw new Error('Daemon returned an undeclared OAuth authentication phase.');
          }
          if (!response.authorizationUrl) {
            throw new Error('Daemon did not provide an OAuth authorization URL.');
          }
          console.log(`\n${dim('Open this authorization URL:')}\n${response.authorizationUrl}\n`);
          if (!params.options.noOpen) {
            await openBrowser(response.authorizationUrl);
          }
          const expectedState = new URL(response.authorizationUrl).searchParams.get('state');
          const allowRawAuthorizationCode = mode.allowRawAuthorizationCode === true && Boolean(expectedState);
          const pasted = await promptInput(allowRawAuthorizationCode
            ? 'Paste the authorization code, final redirect URL, or code#state: '
            : 'Paste the final redirect URL: ', { signal: params.signal });
          const parsed = parseOauthRedirectPaste({
            pasted,
            redirectUri: mode.callbackUrl ?? response.callbackUrl,
            allowRawAuthorizationCode,
          });
          if (!parsed.ok) {
            throw new Error(`Invalid OAuth callback (${parsed.error}).`);
          }
          const state = parsed.rawAuthorizationCode ? expectedState : parsed.state;
          if (!state || (expectedState && state !== expectedState)) {
            throw new Error('OAuth callback state does not match this authentication attempt.');
          }
          response = await params.client.authenticate({
            operation: 'completeOAuth',
            attemptId: response.attemptId,
            completion: {
              code: parsed.code,
              callbackUrl: response.callbackUrl,
              state,
              ...('iss' in parsed && parsed.iss ? { iss: parsed.iss } : {}),
            },
          });
          break;
        }
        case 'awaitingDeviceAuthorization': {
          if (renderedDeviceAttemptId !== response.attemptId) {
            leaveWaiting();
            const verificationUrl =
              response.verificationUriComplete ?? response.verificationUri;
            console.log(
              [
                '',
                response.userCode
                  ? `Device code: ${response.userCode}`
                  : 'Complete device authorization in the browser.',
                verificationUrl ? `Verification URL: ${verificationUrl}` : null,
                '',
              ]
                .filter((line): line is string => line !== null)
                .join('\n'),
            );
            if (verificationUrl && !params.options.noOpen) {
              await openBrowser(verificationUrl);
            }
            renderedDeviceAttemptId = response.attemptId;
            steps.start('Waiting for authorization');
            waiting = true;
          }
          await delay(Math.max(250, response.pollIntervalMs ?? 1_000));
          response = await params.client.authenticate({
            operation: 'pollDevice',
            attemptId: response.attemptId,
          });
          break;
        }
        case 'pending': {
          const mode = resolveAuthenticationMode();
          if (!mode) {
            throw new Error(
              'Daemon returned a pending phase for an undeclared authentication mode.',
            );
          }
          await delay(Math.max(250, response.retryAfterMs));
          response = await params.client.authenticate({
            operation: mode.kind === 'oauthDeviceCode'
              ? 'pollDevice'
              : 'reconcile',
            attemptId: response.attemptId,
          });
          break;
        }
        case 'configurationRequired': {
          leaveWaiting();
          const revision = await replaceRequiredConfiguration({
            client: params.client,
            response,
          });
          if (response.attemptId) {
            response = await params.client.authenticate({
              operation: 'continueConnect',
              attemptId: response.attemptId,
              ...(revision ? { expectedConfigurationRevision: revision } : {}),
            });
          } else if (params.intent.kind === 'connect') {
            response = await params.client.authenticate({
              operation: 'beginConnect',
              service: params.intent.service,
              modeId: params.intent.modeId,
              ...(revision ? { expectedConfigurationRevision: revision } : {}),
            });
          } else {
            response = await params.client.authenticate({
              operation: 'beginReconnect',
              account: params.intent.account,
              ...(revision ? { expectedConfigurationRevision: revision } : {}),
            });
          }
          break;
        }
        case 'outcomeUnknown':
          response = await params.client.authenticate({
            operation: 'reconcile',
            attemptId: response.attemptId,
          });
          break;
        case 'cleanupPending':
          response = await params.client.authenticate({
            operation: 'cancel',
            attemptId: response.attemptId,
          });
          break;
        case 'connected':
          if (waiting) {
            waiting = false;
            steps.stop('✓', 'Authorized');
          }
          return response;
        case 'cancelled':
        case 'reconnectRequired':
        case 'rejected':
        case 'unavailable':
        case 'conflict':
          throw new Error(
            `Connected-account authentication failed (${describeFailure(response)}).`,
          );
      }
    }
    throw new Error('Connected-account authentication exceeded its operation bound.');
  } catch (error) {
    if (params.signal?.aborted && 'attemptId' in response && response.attemptId) {
      await params.client.authenticate({ operation: 'cancel', attemptId: response.attemptId }).catch(() => undefined);
    }
    if (waiting) {
      waiting = false;
      steps.stop('x', 'Waiting for authorization');
    }
    throw error;
  } finally {
    if (
      'attemptId' in response
      && response.attemptId
      && (
        response.status === 'connected'
        || response.status === 'cancelled'
        || response.status === 'reconnectRequired'
        || response.status === 'rejected'
        || response.status === 'unavailable'
        || response.status === 'conflict'
      )
    ) {
      // This interactive journey has consumed its terminal reply. Lost replies
      // and unresolved effects still belong to the daemon's resumable attempt.
      await params.client.authenticate({ operation: 'cancel', attemptId: response.attemptId }).catch(() => undefined);
    }
  }
}

async function describeService(
  client: ConnectedAccountDaemonClient,
  target: ConnectTarget,
): Promise<DescribedService> {
  const response = await client.control({
    operation: 'describeService',
    service: target.service,
  });
  if (response.status !== 'described') {
    throw new Error(
      `Connected-account service unavailable (${controlFailureCode(response)}).`,
    );
  }
  if (!sameService(response.service, target.service)) {
    throw new Error('Daemon described a different connected-account service.');
  }
  return response;
}

async function handleConnectTarget(
  client: ConnectedAccountDaemonClient,
  target: ConnectTarget,
  options: ConnectParsedOptions,
  signal?: AbortSignal,
): Promise<void> {
  console.log(
    `\n${banner(`Connecting ${localizedText(target.descriptor.title) || target.commandId}`, {
      subtitle: 'Happier daemon',
    })}\n`,
  );
  const described = await describeService(client, target);
  const nativeImport = options.import ? resolveConnectNativeImportIntent(described.descriptor.authentication.modes, options.source) : null;
  const accountId =
    options.accountId ??
    (options.profileId !== 'default' ? options.profileId : null);
  const intent: AuthenticationIntent = accountId
    ? {
        kind: 'reconnect',
        account: {
          service: target.service,
          accountId,
        },
      }
    : {
        kind: 'connect',
        service: target.service,
        modeId: nativeImport?.modeId ?? modeSelectedByFlags(described, target, options).id,
      };
  console.error(`Connect may require approval before credential entry. Review requests in Happier's Inbox or another terminal using the same Home: ${cmd('happier actions invoke approval.request.list --json')}`);
  const initial =
    intent.kind === 'reconnect'
      ? await client.authenticate({
          operation: 'beginReconnect',
          account: intent.account,
        })
      : await client.authenticate({
          operation: 'beginConnect',
          service: intent.service,
          modeId: intent.modeId,
        });
  const connected = await continueConnectedAccountAuthentication({
    client,
    described,
    intent,
    initial,
    options,
    ...(signal ? { signal } : {}),
    ...(nativeImport ? { nativeImportFields: nativeImport.fields } : {}),
  });
  console.log(
    ok(
      `${localizedText(described.descriptor.title) || target.commandId}: connected (${connected.account.accountId})`,
    ),
  );
}

function accountPresentation(
  account: QualifiedConnectedAccountProfileV4,
): string {
  return (
    account.providerIdentity?.email ??
    account.providerIdentity?.accountId ??
    account.displayName ??
    account.ref.accountId
  );
}

async function handleConnectStatus(client: ConnectedAccountDaemonClient, targets: readonly ConnectTarget[]): Promise<void> {
  console.log(`\n${sectionTitle('Connection status')}\n`);
  for (const target of targets) {
    const fallbackTitle =
      localizedText(target.descriptor.title) || target.commandId;
    try {
      const described = await describeService(client, target);
      const title = localizedText(described.descriptor.title) || fallbackTitle;
      const connected = described.accounts.filter(
        (account) => account.status === 'connected',
      );
      if (connected.length === 0) {
        const needsReconnect = described.accounts.length > 0;
        console.log(
          `  ${
            (needsReconnect ? warn : neutral)(
              `${title}: ${needsReconnect ? 'needs re-auth' : 'not connected'}`,
            )
          }`,
        );
        continue;
      }
      console.log(
        `  ${ok(`${title}: connected`)}${gray(
          ` (${connected.map(accountPresentation).join(', ')})`,
        )}`,
      );
    } catch (error) {
      if (process.env.DEBUG) {
        console.error(
          gray(`[debug] failed to check ${fallbackTitle} connection:`),
          error,
        );
      }
      console.log(`  ${warn(`${fallbackTitle}: unknown (check failed)`)}`);
    }
  }
  console.log('');
}

export async function handleConnectCommand(args: string[], signal?: AbortSignal): Promise<void> {
  const { subcommand, options } = parseConnectArgs(args);

  if (
    !subcommand ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    await printConnectHelp(configuration.happyHomeDir);
    return;
  }
  const client = await createDaemonClient(signal, args.includes('--yes'));
  try {
    const targets = await loadConnectTargets(client);
    if (subcommand.toLowerCase() === 'status') {
      await handleConnectStatus(client, targets);
      return;
    }
    const target = findTarget(targets, subcommand);
    if (!target) {
      throw new Error(`Unknown or ambiguous connected-account service: ${subcommand}`);
    }
    await handleConnectTarget(client, target, options, signal);
  } finally {
    await client.dispose();
  }
}

export async function handleConnectCliCommand(
  context: CommandContext,
): Promise<void> {
  try {
    await handleConnectCommand(context.args.slice(1), context.signal);
  } catch (error) {
    if (error && typeof error === 'object' && 'details' in error
      && await tryHandleApprovalRequestCreated({ envelopeKind: 'connect', json: false, result: error.details })) return;
    console.error(
      errorFrame(error instanceof Error ? error.message : 'Unknown error'),
    );
    if (process.env.DEBUG) console.error(error);
    process.exit(1);
  }
}

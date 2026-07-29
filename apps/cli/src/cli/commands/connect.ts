import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  PluginConnectedAccountDescriptorContributionV2Schema,
  PluginJsonValueV2Schema,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountDescriptorContributionV2,
  type PluginContributionIdentityV1,
  type PluginJsonValueV2,
  type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';
import {
  banner,
  bullets,
  cmd,
  dim,
  errorFrame,
  gray,
  neutral,
  ok,
  sectionTitle,
  warn,
} from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { configuration } from '@/configuration';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';
import { readCredentials } from '@/persistence';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { openBrowser } from '@/ui/openBrowser';
import { delay } from '@/utils/time';

import {
  createConnectedAccountDaemonClient,
  type ConnectedAccountDaemonClient,
} from './connect/connectedAccountDaemonClient';
import { parseConnectArgs, type ConnectParsedOptions } from './connect/parseConnectArgs';

type AttemptResponse = Awaited<
  ReturnType<ConnectedAccountDaemonClient['authenticate']>
>;
type ControlResponse = Awaited<
  ReturnType<ConnectedAccountDaemonClient['control']>
>;
type DescribedService = Extract<ControlResponse, { status: 'described' }>;
type ConfigurationDescription = Extract<
  ControlResponse,
  { status: 'configuration' | 'configurationCommitted' }
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

type ConnectTarget = Readonly<{
  service: PluginContributionIdentityV1;
  descriptor: PluginConnectedAccountDescriptorContributionV2;
  commandId: string;
  aliases: readonly string[];
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

function localizedText(
  value: string | Readonly<{ fallback: string }> | undefined,
): string {
  return typeof value === 'string' ? value : value?.fallback ?? '';
}

function sameService(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function exactServiceCommandId(service: PluginContributionIdentityV1): string {
  return `${service.pluginId}/${service.localId}`;
}

function legacyServiceIdFor(
  service: PluginContributionIdentityV1,
): string | null {
  for (const [serviceId, compatibility] of Object.entries(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  )) {
    if (sameService(service, compatibility.service)) return serviceId;
  }
  return null;
}

function resolveConnectTargets(
  registry: Pick<ResolvedContributionRegistry, 'connectedAccountDescriptors'>,
): readonly ConnectTarget[] {
  const candidates = (registry.connectedAccountDescriptors ?? []).flatMap(
    (contribution) => {
      const pluginId = contribution.pluginId?.trim();
      if (!pluginId) return [];
      const descriptor =
        PluginConnectedAccountDescriptorContributionV2Schema.safeParse(
          contribution.definition,
        );
      if (!descriptor.success) return [];
      const service = Object.freeze({
        pluginId,
        localId: descriptor.data.id,
      });
      return [
        {
          service,
          descriptor: descriptor.data,
          legacyServiceId: legacyServiceIdFor(service),
        },
      ];
    },
  );
  const localIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    localIdCounts.set(
      candidate.service.localId,
      (localIdCounts.get(candidate.service.localId) ?? 0) + 1,
    );
  }
  return Object.freeze(
    candidates
      .map(({ service, descriptor, legacyServiceId }) => {
        const exactId = exactServiceCommandId(service);
        const aliases = new Set<string>([exactId]);
        if (localIdCounts.get(service.localId) === 1) {
          aliases.add(service.localId);
        }
        if (legacyServiceId) aliases.add(legacyServiceId);
        return Object.freeze({
          service,
          descriptor,
          commandId: legacyServiceId ?? (
            localIdCounts.get(service.localId) === 1
              ? service.localId
              : exactId
          ),
          aliases: Object.freeze([...aliases]),
        });
      })
      .sort((left, right) => left.commandId.localeCompare(right.commandId)),
  );
}

async function loadConnectTargets(): Promise<readonly ConnectTarget[]> {
  const registry = await resolveMergedContributionRegistry({
    happyHomeDir: configuration.happyHomeDir,
  });
  return resolveConnectTargets(registry);
}

function showConnectHelp(targets: readonly ConnectTarget[]): void {
  const targetLines =
    targets.length > 0
      ? targets
          .map((target) => {
            const title =
              localizedText(target.descriptor.title) || target.service.localId;
            return `  happier connect ${target.commandId.padEnd(20)} ${title}`;
          })
          .join('\n')
      : '  (no connected-account services registered)';
  console.log(
    [
      `${sectionTitle('happier connect')} - Connect accounts through the Happier daemon`,
      '',
      sectionTitle('Usage:'),
      targetLines,
      `  ${cmd('happier connect status')}                      Show connection status`,
      `  ${cmd('happier connect <service> --account <id>')}    Reconnect an exact account`,
      `  ${cmd('happier connect <service> --mode <mode>')}     Select an authentication mode`,
      `  ${cmd('happier connect <service> --oauth')}           Select authorization-code OAuth`,
      `  ${cmd('happier connect <service> --device')}          Select device-code OAuth`,
      `  ${cmd('happier connect <service> --token')}           Select the built-in token mode`,
      `  ${cmd('happier connect <service> --no-open')}         Do not open a browser`,
      `  ${cmd('happier connect <service> --timeout <seconds>')} Bound the interactive flow`,
      '',
      sectionTitle('Notes:'),
      bullets([
        `Authenticate with Happier first using ${cmd('happier auth login')}`,
        'Authentication state, PKCE, credentials, and settlement stay in the selected daemon',
        'External services use the unambiguous <pluginId>/<localId> command form',
      ]),
      '',
    ].join('\n'),
  );
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

async function createDaemonClient(): Promise<ConnectedAccountDaemonClient> {
  const credentials = await readCredentials();
  if (!credentials) {
    throw new Error(
      `Not authenticated with Happier. Run ${cmd('happier auth login')} first.`,
    );
  }
  const { machineId } = await ensureMachineIdForCredentials(credentials);
  return createConnectedAccountDaemonClient({ credentials, machineId });
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

async function continueAuthentication(params: Readonly<{
  client: ConnectedAccountDaemonClient;
  described: DescribedService;
  intent: AuthenticationIntent;
  initial: AttemptResponse;
  options: ConnectParsedOptions;
}>): Promise<Extract<AttemptResponse, { status: 'connected' }>> {
  const startedAt = Date.now();
  const timeoutMs = (params.options.timeoutSeconds ?? 10 * 60) * 1000;
  let response = params.initial;
  let renderedDeviceAttemptId: string | null = null;
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

  for (let step = 0; step < 1_000; step += 1) {
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
        const mode = resolveAuthenticationMode();
        if (!mode || mode.kind !== 'manual') {
          throw new Error('Daemon returned an undeclared manual authentication phase.');
        }
        response = await params.client.authenticate({
          operation: 'submitManual',
          attemptId: response.attemptId,
          fields: await promptManualFields(mode),
        });
        break;
      }
      case 'awaitingOAuth': {
        if (!response.authorizationUrl) {
          throw new Error('Daemon did not provide an OAuth authorization URL.');
        }
        console.log(`\n${dim('Open this authorization URL:')}\n${response.authorizationUrl}\n`);
        if (!params.options.noOpen) {
          await openBrowser(response.authorizationUrl);
        }
        const pasted = await promptInput('Paste the final redirect URL: ');
        const parsed = parseOauthRedirectPaste({ pasted });
        if (!parsed.ok) {
          throw new Error(`Invalid OAuth callback (${parsed.error}).`);
        }
        response = await params.client.authenticate({
          operation: 'completeOAuth',
          attemptId: response.attemptId,
          completion: {
            code: parsed.code,
            callbackUrl: response.callbackUrl,
            state: parsed.state,
          },
        });
        break;
      }
      case 'awaitingDeviceAuthorization': {
        if (renderedDeviceAttemptId !== response.attemptId) {
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
  target: ConnectTarget,
  options: ConnectParsedOptions,
): Promise<void> {
  console.log(
    `\n${banner(`Connecting ${localizedText(target.descriptor.title) || target.commandId}`, {
      subtitle: 'Happier daemon',
    })}\n`,
  );
  const client = await createDaemonClient();
  const described = await describeService(client, target);
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
        modeId: modeSelectedByFlags(described, target, options).id,
      };
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
  const connected = await continueAuthentication({
    client,
    described,
    intent,
    initial,
    options,
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

async function handleConnectStatus(targets: readonly ConnectTarget[]): Promise<void> {
  console.log(`\n${sectionTitle('Connection status')}\n`);
  const client = await createDaemonClient();
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

export async function handleConnectCommand(args: string[]): Promise<void> {
  const { subcommand, options } = parseConnectArgs(args);
  const targets = await loadConnectTargets();

  if (
    !subcommand ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    showConnectHelp(targets);
    return;
  }
  if (subcommand.toLowerCase() === 'status') {
    await handleConnectStatus(targets);
    return;
  }
  const target = findTarget(targets, subcommand);
  if (!target) {
    throw new Error(`Unknown or ambiguous connected-account service: ${subcommand}`);
  }
  await handleConnectTarget(target, options);
}

export async function handleConnectCliCommand(
  context: CommandContext,
): Promise<void> {
  try {
    await handleConnectCommand(context.args.slice(1));
  } catch (error) {
    console.error(
      errorFrame('Error:', [
        error instanceof Error ? error.message : 'Unknown error',
      ]),
    );
    if (process.env.DEBUG) console.error(error);
    process.exit(1);
  }
}

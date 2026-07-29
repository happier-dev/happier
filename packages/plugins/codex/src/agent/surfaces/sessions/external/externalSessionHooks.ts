import { join } from 'node:path';

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  AgentExternalSessionHookMapEventRequest,
  AgentExternalSessionHookMapEventResult,
  AgentExternalSessionHookResolveInstallationRequest,
  AgentExternalSessionHookResolveInstallationResult,
  AgentExternalSessionHookResolveInstallationValue,
  AgentExternalSessionHooksContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  createCodexNativeAppServerClient,
  type DisposableCodexAppServerClient,
} from '../../../runtime/appServer/client.js';
import { resolveConfiguredCodexHomePath } from '../../../rollout/discovery/homeEntries.js';

export const CODEX_EXTERNAL_SESSION_HOOK_VERSION = '0.145.0';
export const CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID =
  'codex-modern-hooks-v0-145-0-posix';
export const CODEX_EXTERNAL_SESSION_HOOK_WINDOWS_CMD_VARIANT_ID =
  'codex-modern-hooks-v0-145-0-windows-cmd';

const TARGET_ID = 'codex-user-hooks';
const COLLECTION_ID = 'codex-lifecycle-hooks';
const SESSION_START_EVENT_ID = 'codex-session-start';
const STOP_EVENT_ID = 'codex-stop';
const QUALIFIED_HOOK_FACT_TTL_MS = 15_000;
const HOOKS_LIST_MAX_SERIALIZED_BYTES = 1024 * 1024;
const HOOKS_LIST_MAX_HOOKS = 1024;
const HOOKS_LIST_MAX_MESSAGES = 64;
const HOOKS_LIST_MAX_STRING_CODE_UNITS = 16 * 1024;
const textEncoder = new TextEncoder();

const READINESS_DIAGNOSTIC = Object.freeze({
  code: 'codex_hooks_approval_required',
  severity: 'warning' as const,
  message: 'Approve the installed hooks in Codex before enabling monitoring.',
  remediation: Object.freeze({ kind: 'openSettings' as const, path: '/hooks' }),
});

const HOOK_EVENT_NAMES = new Set([
  'preToolUse',
  'permissionRequest',
  'postToolUse',
  'preCompact',
  'postCompact',
  'sessionStart',
  'sessionEnd',
  'userPromptSubmit',
  'subagentStart',
  'subagentStop',
  'stop',
]);
const HOOK_HANDLER_TYPES = new Set(['command', 'prompt', 'agent']);
const HOOK_SOURCES = new Set([
  'system',
  'user',
  'project',
  'mdm',
  'sessionFlags',
  'plugin',
  'cloudRequirements',
  'cloudManagedConfig',
  'legacyManagedConfigFile',
  'legacyManagedConfigMdm',
  'unknown',
]);
const HOOK_TRUST_STATUSES = new Set([
  'managed',
  'untrusted',
  'trusted',
  'modified',
]);

type CodexHookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified';
type CodexListedHook = Readonly<{
  key: string;
  eventName: string;
  handlerType: string;
  matcher: string | null;
  command: string | null;
  timeoutSec: number;
  sourcePath: string;
  enabled: boolean;
  trustStatus: CodexHookTrustStatus;
}>;

function installationVariant(
  variantId: string,
  shellDialect: 'posix' | 'windows_cmd',
) {
  return Object.freeze({
    variantId,
    targets: Object.freeze([
      Object.freeze({
        targetId: TARGET_ID,
        format: 'hook_event_json_arrays_v1' as const,
        collectionId: COLLECTION_ID,
      }),
    ]),
    events: Object.freeze([
      Object.freeze({
        eventId: SESSION_START_EVENT_ID,
        targetId: TARGET_ID,
        nativeEventName: 'SessionStart',
        command: Object.freeze({
          kind: 'happier_observation_v1' as const,
          shellDialect,
        }),
      }),
      Object.freeze({
        eventId: STOP_EVENT_ID,
        targetId: TARGET_ID,
        nativeEventName: 'Stop',
        command: Object.freeze({
          kind: 'happier_observation_v1' as const,
          shellDialect,
        }),
      }),
    ]),
  });
}

const INSTALLATION_VARIANTS = Object.freeze([
  installationVariant(CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID, 'posix'),
  installationVariant(
    CODEX_EXTERNAL_SESSION_HOOK_WINDOWS_CMD_VARIANT_ID,
    'windows_cmd',
  ),
]);

const INSTALLATION_VARIANT_IDS = new Set(INSTALLATION_VARIANTS.map(
  (variant) => variant.variantId,
));

type CodexExternalSessionHooksOptions = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
}>;

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function readNonEmptyString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = record[field];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function ignored(): AgentExternalSessionHookMapEventResult {
  return { ok: true, value: { kind: 'ignored' } };
}

function ok<T>(value: T): AgentExternalSessionsResult<T> {
  return { ok: true, value };
}

function failed(
  code: AgentExternalSessionsFailureCode,
  message: string,
  retryable?: boolean,
): AgentExternalSessionsResult<never> {
  return {
    ok: false,
    code,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function invocationFailure(
  request: AgentExternalSessionHookResolveInstallationRequest,
  context: PluginInvocationContext,
): AgentExternalSessionsResult<never> | null {
  if (context.signal.aborted || request.signal.aborted) {
    return failed(
      'cancelled',
      'Codex External Session hook readiness probe was cancelled.',
    );
  }
  if (Date.now() >= request.deadlineAtMs) {
    return failed(
      'timeout',
      'Codex External Session hook readiness probe exceeded its deadline.',
      true,
    );
  }
  return null;
}

function isExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Readonly<Record<string, unknown>> {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => keys.includes(key))
    && keys.every((key) => allowed.has(key));
}

function isBoundedString(value: unknown): value is string;
function isBoundedString(
  value: unknown,
  options: Readonly<{ nullable?: false; allowEmpty?: boolean }>,
): value is string;
function isBoundedString(
  value: unknown,
  options: Readonly<{ nullable: true; allowEmpty?: boolean }>,
): value is string | null;
function isBoundedString(
  value: unknown,
  options: Readonly<{ nullable?: boolean; allowEmpty?: boolean }> = {},
): value is string | null {
  if (options.nullable && value === null) return true;
  return typeof value === 'string'
    && (options.allowEmpty === true || value.length > 0)
    && value.length <= HOOKS_LIST_MAX_STRING_CODE_UNITS
    && !value.includes('\u0000');
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= HOOKS_LIST_MAX_MESSAGES
    && value.every((item) => isBoundedString(item, { allowEmpty: true }));
}

function parseListedHook(value: unknown): CodexListedHook | null {
  if (!isExactRecord(
    value,
    [
      'key',
      'eventName',
      'handlerType',
      'isManaged',
      'sourcePath',
      'source',
      'displayOrder',
      'enabled',
      'currentHash',
      'trustStatus',
      'timeoutSec',
    ],
    [
      'matcher',
      'command',
      'statusMessage',
      'pluginId',
      'additionalContextLimit',
    ],
  )) {
    return null;
  }
  if (!isBoundedString(value.key)
    || !isBoundedString(value.eventName)
    || !HOOK_EVENT_NAMES.has(value.eventName)
    || !isBoundedString(value.handlerType)
    || !HOOK_HANDLER_TYPES.has(value.handlerType)
    || typeof value.isManaged !== 'boolean'
    || !isBoundedString(value.sourcePath)
    || !isBoundedString(value.source)
    || !HOOK_SOURCES.has(value.source)
    || !Number.isSafeInteger(value.displayOrder)
    || typeof value.enabled !== 'boolean'
    || !isBoundedString(value.currentHash)
    || !isBoundedString(value.trustStatus)
    || !HOOK_TRUST_STATUSES.has(value.trustStatus)
    || !isNonnegativeSafeInteger(value.timeoutSec)
    || (value.matcher !== undefined
      && !isBoundedString(value.matcher, { nullable: true, allowEmpty: true }))
    || (value.command !== undefined
      && !isBoundedString(value.command, { nullable: true, allowEmpty: true }))
    || (value.statusMessage !== undefined
      && !isBoundedString(
        value.statusMessage,
        { nullable: true, allowEmpty: true },
      ))
    || (value.pluginId !== undefined
      && !isBoundedString(value.pluginId, { nullable: true, allowEmpty: true }))
    || (value.additionalContextLimit !== undefined
      && value.additionalContextLimit !== null
      && !isNonnegativeSafeInteger(value.additionalContextLimit))) {
    return null;
  }
  return {
    key: value.key,
    eventName: value.eventName,
    handlerType: value.handlerType,
    matcher: typeof value.matcher === 'string' ? value.matcher : null,
    command: typeof value.command === 'string' ? value.command : null,
    timeoutSec: value.timeoutSec,
    sourcePath: value.sourcePath,
    enabled: value.enabled,
    trustStatus: value.trustStatus as CodexHookTrustStatus,
  };
}

function parseHooksListResponse(value: unknown): readonly CodexListedHook[] | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (textEncoder.encode(serialized).byteLength > HOOKS_LIST_MAX_SERIALIZED_BYTES
    || !isExactRecord(value, ['data'])
    || !Array.isArray(value.data)
    || value.data.length > 1) {
    return null;
  }

  const hooks: CodexListedHook[] = [];
  for (const entry of value.data) {
    if (!isExactRecord(entry, ['cwd', 'hooks', 'warnings', 'errors'])
      || !isBoundedString(entry.cwd, { allowEmpty: true })
      || !Array.isArray(entry.hooks)
      || entry.hooks.length > HOOKS_LIST_MAX_HOOKS
      || !isBoundedStringArray(entry.warnings)
      || !Array.isArray(entry.errors)
      || entry.errors.length > HOOKS_LIST_MAX_MESSAGES) {
      return null;
    }
    for (const error of entry.errors) {
      if (!isExactRecord(error, ['message', 'path'])
        || !isBoundedString(error.message, { allowEmpty: true })
        || !isBoundedString(error.path, { allowEmpty: true })) {
        return null;
      }
    }
    for (const hook of entry.hooks) {
      const parsed = parseListedHook(hook);
      if (!parsed) return null;
      hooks.push(parsed);
    }
  }
  return hooks;
}

function appServerEventIdentity(
  nativeEventName: string,
): Readonly<{ eventName: string; keySegment: string }> | null {
  if (nativeEventName === 'SessionStart') {
    return { eventName: 'sessionStart', keySegment: 'session_start' };
  }
  if (nativeEventName === 'Stop') {
    return { eventName: 'stop', keySegment: 'stop' };
  }
  return null;
}

function hasReadyCustodiedHooks(
  request: AgentExternalSessionHookResolveInstallationRequest,
  hooks: readonly CodexListedHook[],
): boolean {
  const custody = request.custody;
  if (!custody) return true;
  return custody.targets.every((target) => target.entries.every((owned) => {
    const eventIdentity = appServerEventIdentity(owned.nativeEventName);
    if (!eventIdentity) return false;
    const expectedHook = owned.entry.hooks[0];
    const expectedKey = [
      target.absolutePath,
      eventIdentity.keySegment,
      owned.entryIndex,
      0,
    ].join(':');
    return hooks.some((hook) => (
      hook.sourcePath === target.absolutePath
      && hook.key === expectedKey
      && hook.eventName === eventIdentity.eventName
      && hook.matcher === owned.entry.matcher
      && hook.command === expectedHook.command
      && hook.timeoutSec === expectedHook.timeout
      && hook.handlerType === expectedHook.type
      && hook.enabled
      && (hook.trustStatus === 'managed' || hook.trustStatus === 'trusted')
    ));
  }));
}

function resolveCodexHome(
  options: CodexExternalSessionHooksOptions,
): string {
  return resolveConfiguredCodexHomePath(options.env);
}

function supportedValue(
  request: AgentExternalSessionHookResolveInstallationRequest,
  options: CodexExternalSessionHooksOptions,
  readiness: Extract<
    AgentExternalSessionHookResolveInstallationValue,
    Readonly<{ kind: 'supported' }>
  >['readiness'],
): AgentExternalSessionHookResolveInstallationValue {
  return {
    kind: 'supported',
    variantId: request.installation.platform === 'win32'
      ? CODEX_EXTERNAL_SESSION_HOOK_WINDOWS_CMD_VARIANT_ID
      : CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID,
    targets: [{
      targetId: TARGET_ID,
      absolutePath: join(resolveCodexHome(options), 'hooks.json'),
    }],
    readiness,
  };
}

async function disposeClient(
  client: DisposableCodexAppServerClient | null,
): Promise<void> {
  if (!client) return;
  await client.dispose().catch(() => undefined);
}

function mapHookEvent(
  request: AgentExternalSessionHookMapEventRequest,
): AgentExternalSessionHookMapEventResult {
  if (!INSTALLATION_VARIANT_IDS.has(request.variantId)
    || !isJsonObject(request.nativePayload)) {
    return ignored();
  }

  const remoteSessionId = readNonEmptyString(request.nativePayload, 'session_id');
  if (!remoteSessionId) return ignored();

  if (request.eventId === SESSION_START_EVENT_ID) {
    return {
      ok: true,
      value: {
        kind: 'mapped',
        sourceInput: { kind: 'codexHome', home: 'user' },
        remoteSessionId,
        facts: [],
      },
    };
  }

  if (request.eventId !== STOP_EVENT_ID
    || request.nativePayload.stop_hook_active !== false) {
    return ignored();
  }
  const turnId = readNonEmptyString(request.nativePayload, 'turn_id');
  if (!turnId) return ignored();

  return {
    ok: true,
    value: {
      kind: 'mapped',
      sourceInput: { kind: 'codexHome', home: 'user' },
      remoteSessionId,
      facts: [
        {
          kind: 'turn_phase',
          value: 'idle',
          evidenceClass: 'qualified_hook',
          observedAtMs: request.observedAtMs,
          expiresAtMs: Math.min(
            Number.MAX_SAFE_INTEGER,
            request.observedAtMs + QUALIFIED_HOOK_FACT_TTL_MS,
          ),
        },
        {
          kind: 'completed_boundary',
          boundaryId: turnId,
          evidenceClass: 'qualified_hook',
          observedAtMs: request.observedAtMs,
        },
      ],
    },
  };
}

export function createCodexExternalSessionHooksContribution(
  options: CodexExternalSessionHooksOptions,
): AgentExternalSessionHooksContribution {
  return Object.freeze({
    installationVariants: INSTALLATION_VARIANTS,
    async resolveInstallation(
      request: AgentExternalSessionHookResolveInstallationRequest,
      context: PluginInvocationContext,
    ): Promise<AgentExternalSessionHookResolveInstallationResult> {
      if (request.installation.installedVersion !== CODEX_EXTERNAL_SESSION_HOOK_VERSION) {
        return {
          ok: true,
          value: { kind: 'unsupported', reason: 'version_unsupported' },
        };
      }

      const stopped = invocationFailure(request, context);
      if (stopped) return stopped;
      if (!request.custody) {
        return ok(supportedValue(request, options, { kind: 'ready' }));
      }

      let client: DisposableCodexAppServerClient | null = null;
      try {
        client = await createCodexNativeAppServerClient({
          exec: context.services.exec,
          processEnv: { CODEX_HOME: resolveCodexHome(options) },
          signal: context.signal,
        });
        const response = await client.request('hooks/list', { cwds: [] });
        const afterProbe = invocationFailure(request, context);
        if (afterProbe) return afterProbe;
        const hooks = parseHooksListResponse(response);
        return ok(supportedValue(
          request,
          options,
          hooks && hasReadyCustodiedHooks(request, hooks)
            ? { kind: 'ready' }
            : {
              kind: 'needs_attention',
              diagnostic: READINESS_DIAGNOSTIC,
            },
        ));
      } catch {
        const afterFailure = invocationFailure(request, context);
        if (afterFailure) return afterFailure;
        return ok(supportedValue(request, options, {
          kind: 'needs_attention',
          diagnostic: READINESS_DIAGNOSTIC,
        }));
      } finally {
        await disposeClient(client);
      }
    },
    mapHookEvent,
  });
}

export const codexExternalSessionHooksContribution =
  createCodexExternalSessionHooksContribution({ env: process.env });

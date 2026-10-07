import { redactVoicePathLikeData } from '@/voice/shared/redactVoicePathLikeData';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SESSION_AWARENESS_OPERATIONAL_PRIMARY_PRECEDENCE_V1, SessionAwarenessProjectionV1Schema, type SessionOperationalReasonV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { SessionActivityCompatibilityResultV1Schema } from '@happier-dev/protocol/sessions/awareness/action';
import { PluginUiHostApiErrorCodeV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
  isInventoryPrivacyVoiceToolName,
  isRecentMessagesPrivacyVoiceToolName,
} from '@/sync/domains/settings/actionSettingsPolicy';

/**
 * Privacy preferences that gate what voice tool-result detail is allowed to cross the provider
 * boundary (the `VOICE_TOOL_RESULTS_JSON` follow-up channel). This is the single owner of
 * provider-bound tool-result redaction: every tool result — regardless of which `tools/actionImpl`
 * leaf produced it — is routed through {@link redactVoiceToolResultValue} before it reaches the
 * model, so session summaries, file paths, and pending permission state are gated consistently.
 */
export type VoiceToolResultRedactionPrefs = Readonly<{
  shareFilePaths: boolean;
  shareSessionSummary: boolean;
  sharePermissionRequests: boolean;
  shareDeviceInventory?: boolean;
  shareRecentMessages?: boolean;
}>;

/**
 * Session reference objects (`{ id, title, locationLabel, serverId, serverName }`) carry the session
 * `title`, which is the session SUMMARY text. When summary sharing is disabled those titles must not
 * reach the provider. The human-summary resolver treats `title ?? label ?? name` as equivalent
 * session-summary text, so the raw-channel key-set mirrors that title-equivalent set — otherwise a
 * tool result carrying a session under a `label`/`name` key would survive `shareSessionSummary=false`
 * on the raw `VOICE_TOOL_RESULTS_JSON` channel (X-L2).
 */
const SESSION_SUMMARY_KEYS: ReadonlySet<string> = new Set(['title', 'label', 'name', 'currentWork']);

/**
 * Current-UI presentation is admitted and privacy-qualified by the current
 * UI composer before it reaches this provider boundary. Its navigation,
 * entity, and command labels are governed by `currentUiContextMode`, not by
 * the unrelated session-summary preference. Keep this classification at the
 * one result-redaction owner; every other tool still treats these keys as
 * session-summary aliases.
 */
const CURRENT_UI_CONTEXT_READ_TOOL_NAME = String(
  getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '',
).trim();

/**
 * Action and current-UI command execution cross an authority boundary before
 * reaching the provider. Their opaque result JSON can contain connection
 * identifiers, provider diagnostics, or credentials, so expose only the
 * host-owned terminal settlement. Other tools may legitimately return IDs and
 * retain the normal privacy projection below.
 */
const ACTION_RESULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  String(getActionSpec('action.invoke').bindings?.voiceClientToolName ?? '').trim(),
  String(getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName ?? '').trim(),
].filter((toolName) => toolName.length > 0));
const ACTION_RESULT_HANDLER_ERROR_CODES: ReadonlySet<string> = new Set([
  'action_unavailable',
  'current_ui_command_unavailable',
  'invalid_parameters',
  'tool_cancelled',
  'outcome_unknown',
]);

/**
 * `locationLabel` is a repo/workspace path tail. Path-bearing string values elsewhere are handled by
 * {@link redactVoicePathLikeData}, but the label key itself can hold a non-path workspace alias, so
 * it is dropped wholesale when path sharing is disabled (mirrors the `listSessions` tool gating).
 */
const FILE_PATH_KEYS: ReadonlySet<string> = new Set(['locationLabel']);

/**
 * Pending permission-request identifiers/state surfaced by the session-activity tool.
 */
const PERMISSION_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'permissionRequestIds',
  'requestId',
  'requestIds',
]);

/**
 * `sharePermissionRequests` gates every pending agent request, not only permission prompts: the
 * push path ({@link file://./voiceHooks.ts} `onAgentRequest`) drops permission AND user-action
 * announcements under the same preference, and the released `ui-web-v0.2.11` activity tool
 * suppressed `permissionRequired`/`actionRequired`/`blocked` together. Both gated reasons are
 * therefore withheld here so the pull path cannot disclose what the push path hides.
 */
const GATED_PENDING_REQUEST_REASONS: ReadonlySet<SessionOperationalReasonV1> = new Set([
  'permission_required',
  'action_required',
]);

/**
 * Pending-request counts are the same disclosure as the booleans beside them, so the released
 * digest's optional/CLI count fields are withheld rather than rewritten to a fabricated zero.
 */
const GATED_PENDING_REQUEST_COUNT_KEYS: readonly string[] = [
  'pendingPermissionRequestCount',
  'pendingUserActionRequestCount',
];

/**
 * The canonical awareness object remains unchanged in application state. At the provider privacy
 * boundary, hiding permission requests also has to hide the semantic fact that one exists; merely
 * deleting request IDs would still tell the provider that the user is being asked for permission.
 * Re-selecting from the remaining already-canonical reasons is a redaction projection, not a second
 * awareness decision owner.
 *
 * `session.activity.get` answers with awareness or with its released compatibility digest, and the
 * digest carries the same fact as derived booleans. Two representations of one Action must not
 * disagree about privacy, so the digest is projected the same way.
 */
function redactPendingRequestState(value: unknown): unknown {
  const awareness = SessionAwarenessProjectionV1Schema.safeParse(value);
  if (awareness.success) {
    const reasons = awareness.data.operational.reasons.filter(
      (reason) => !GATED_PENDING_REQUEST_REASONS.has(reason),
    );
    const primary = SESSION_AWARENESS_OPERATIONAL_PRIMARY_PRECEDENCE_V1.find(
      (candidate) => reasons.some((reason) => reason === candidate),
    ) ?? 'none';
    return { ...awareness.data, operational: { primary, reasons } };
  }
  if (!SessionActivityCompatibilityResultV1Schema.safeParse(value).success) return value;
  const digest = value as Readonly<Record<string, unknown>>;
  return {
    ...Object.fromEntries(
      Object.entries(digest).filter(([key]) => !GATED_PENDING_REQUEST_COUNT_KEYS.includes(key)),
    ),
    // `blocked` is exactly `permissionRequired || actionRequired` at the canonical adapter, so
    // withholding both requirements settles it rather than inventing an unrelated fact.
    ...(typeof digest.permissionRequired === 'boolean' ? { permissionRequired: false } : {}),
    ...(typeof digest.actionRequired === 'boolean' ? { actionRequired: false } : {}),
    ...(typeof digest.blocked === 'boolean' ? { blocked: false } : {}),
  };
}

function shouldDropKey(
  key: string,
  prefs: VoiceToolResultRedactionPrefs,
  allowCurrentUiPresentationLabels: boolean,
): boolean {
  if (!allowCurrentUiPresentationLabels && !prefs.shareSessionSummary && SESSION_SUMMARY_KEYS.has(key)) return true;
  if (!prefs.shareFilePaths && FILE_PATH_KEYS.has(key)) return true;
  if (!prefs.sharePermissionRequests && PERMISSION_REQUEST_KEYS.has(key)) return true;
  return false;
}

function stripGatedKeys(
  value: unknown,
  prefs: VoiceToolResultRedactionPrefs,
  depth: number,
  allowCurrentUiPresentationLabels: boolean,
): unknown {
  // Tool output is untrusted provider-bound data. Returning the untouched
  // subtree at the safety limit would turn the recursion guard into a privacy
  // bypass for deeply nested/cyclic payloads, so truncate fail closed.
  if (depth > 20) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => stripGatedKeys(entry, prefs, depth + 1, allowCurrentUiPresentationLabels));
  }
  if (!value || typeof value !== 'object') return value;
  const privacyProjected = prefs.sharePermissionRequests
    ? value
    : redactPendingRequestState(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(privacyProjected as Record<string, unknown>)) {
    if (shouldDropKey(key, prefs, allowCurrentUiPresentationLabels)) continue;
    output[key] = stripGatedKeys(entry, prefs, depth + 1, allowCurrentUiPresentationLabels);
  }
  return output;
}

/**
 * Redact a voice tool-result (or argument) value for the provider boundary. Strips session
 * summaries and pending permission identifiers per the supplied prefs, then delegates path-like
 * string/key redaction to the canonical {@link redactVoicePathLikeData} owner. This is the only
 * redaction applied to provider-bound tool results — no per-tool redaction path should exist.
 */
export function redactVoiceToolResultValue(value: unknown, prefs: VoiceToolResultRedactionPrefs): unknown {
  return redactVoiceToolResultValueWithClassification(value, prefs, false);
}

function redactVoiceToolResultValueWithClassification(
  value: unknown,
  prefs: VoiceToolResultRedactionPrefs,
  allowCurrentUiPresentationLabels: boolean,
): unknown {
  const resolvedPrefs: VoiceToolResultRedactionPrefs = {
    shareFilePaths: prefs?.shareFilePaths === true,
    shareSessionSummary: prefs?.shareSessionSummary === true,
    sharePermissionRequests: prefs?.sharePermissionRequests === true,
  };
  const stripped = stripGatedKeys(value, resolvedPrefs, 0, allowCurrentUiPresentationLabels);
  return resolvedPrefs.shareFilePaths ? stripped : redactVoicePathLikeData(stripped);
}

function projectActionResultForProvider(value: unknown): Readonly<{
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}> {
  const result = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
  if (result?.ok === true) return { ok: true };
  const rawErrorCode = result?.errorCode;
  const hostErrorCode = PluginUiHostApiErrorCodeV1Schema.safeParse(rawErrorCode);
  const errorCode = typeof rawErrorCode === 'string'
    && ACTION_RESULT_HANDLER_ERROR_CODES.has(rawErrorCode)
    ? rawErrorCode
    : hostErrorCode.success
      ? hostErrorCode.data
      : null;
  if (result?.ok === false && errorCode) {
    return {
      ok: false,
      errorCode,
      errorMessage: errorCode,
    };
  }
  return {
    ok: false,
    errorCode: 'internal_error',
    errorMessage: 'internal_error',
  };
}

export function isVoiceToolResultBlockedByPrivacy(
  toolName: string,
  prefs: VoiceToolResultRedactionPrefs,
): boolean {
  if (prefs?.shareDeviceInventory !== true && isInventoryPrivacyVoiceToolName(toolName)) return true;
  if (prefs?.shareRecentMessages !== true && isRecentMessagesPrivacyVoiceToolName(toolName)) return true;
  return false;
}

export function redactVoiceToolResultForProvider(
  toolName: string,
  value: unknown,
  prefs: VoiceToolResultRedactionPrefs,
): unknown {
  if (isVoiceToolResultBlockedByPrivacy(toolName, prefs)) {
    return {
      ok: false,
      errorCode: 'privacy_disabled',
      errorMessage: 'privacy_disabled',
    };
  }
  if (ACTION_RESULT_TOOL_NAMES.has(toolName)) {
    return projectActionResultForProvider(value);
  }
  return redactVoiceToolResultValueWithClassification(
    value,
    prefs,
    toolName === CURRENT_UI_CONTEXT_READ_TOOL_NAME,
  );
}

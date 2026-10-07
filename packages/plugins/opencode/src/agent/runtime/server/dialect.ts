import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import { normalizeOpenCodeV2Event } from './openCodeV2EventAdapter.js';
import { OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '../../auth/services/requestAuth/env.js';
import type { OpenCodeGlobalEvent, OpenCodeRuntimeFetch } from './openCodeServerClient.js';

/**
 * Which OpenCode HTTP surface a reachable server speaks.
 *
 * `v1` is the long-standing root route space (`/session`, `/event`, `/mcp`,
 * `/global/*`). `v2` serves the `/api/*` surface: first through the separate
 * `opencode2` preview executable, then through released `opencode` 2.x.
 *
 * Transitional probe evidence (`comparators/opencode` at
 * `70a24697ea0028e19f22712fd63059538cb4bee7`):
 *
 * - `packages/app/src/utils/server-protocol.ts` is OpenCode's own discriminator
 *   and the probe order mirrored by `detectOpenCodeServerDialect` below;
 * - that transitional stable binary mounted **both** generations. `OpenCodeHttpApi`
 *   (`packages/opencode/src/server/routes/instance/httpapi/api.ts`) composes its
 *   root/`/global/*`/`/event` groups *and* `ServerApi`, and the serving side
 *   (`.../httpapi/server.ts`) imports `Api` and `handlers` from
 *   `@opencode-ai/server`, so the `/api/*` routes are answered, not merely
 *   declared. A stable build older than this pin need not answer them at all;
 * - the V2 server does not reciprocate. `packages/server/src/api.ts` is
 *   `makeDefaultApi(...)` from `packages/protocol/src/api.ts`, whose entire
 *   route inventory is `/api/*` plus `/experimental/project/:projectID/copy`.
 *   There is no `/global` group and no root `/session` or `/event`;
 * - `packages/opencode/src/config/v2-compat.ts:111` names `opencode2` as the
 *   executable that owns the V2 configuration dialect.
 *
 * That asymmetry is the whole discriminator: `/global/health` is answered only
 * by a V1 server, and it is answered by every V1 server.
 *
 * Selecting `v2` moves the whole surface — request routes, payload shapes,
 * response envelopes and the event stream — onto the standalone V2 contract
 * (`openCodeV2Wire.ts`). Released OpenCode 2.0.15 adds experimental dynamic MCP
 * registration and conversation fork; operations its V2 protocol still does
 * not declare (todo reads and `/global/config`) fail as typed,
 * operation-scoped `unsupported` rather than as invented routes; see
 * `OpenCodeServerUnsupportedOperationError`.
 */
export type OpenCodeServerDialect = 'v1' | 'v2';

/** The native CLI prints either a plain version or `opencode v<version>`. */
export function readOpenCodeCliVersionDialect(version: string | null | undefined): OpenCodeServerDialect | null {
  const major = /^(?:opencode\s+)?v?([12])(?:\.|$)/iu.exec(version?.trim() ?? '')?.[1];
  return major === '1' ? 'v1' : major === '2' ? 'v2' : null;
}

/**
 * The legacy liveness route, mounted only by the V1 instance server
 * (`packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`).
 * The V2 server package declares no `/global/*` group, so a healthy answer here
 * is decisive for V1 — decisive enough that it wins even when an `/api` surface
 * also answers.
 */
export const OPEN_CODE_V1_HEALTH_PATH = '/global/health';

/**
 * The preview `/api` liveness route, also answered by the transitional V1
 * binary. Its pinned success schema is literally
 * `{ healthy: Schema.Literal(true) }`
 * (`packages/protocol/src/groups/health.ts`), and its handler
 * (`packages/server/src/handlers/health.ts`) returns exactly that.
 *
 * Nothing in `packages/server/src` emits a `pid`, so the `typeof pid ===
 * 'number'` branch in OpenCode's own client is unreachable against every pinned
 * server. Mirroring it made `v2` unselectable; the healthy marker plus the
 * absence of the legacy route is what actually separates the two.
 */
export const OPEN_CODE_V2_HEALTH_PATH = '/api/health';
/** Released OpenCode 2.0.15 exposes this authenticated server identity route. */
export const OPEN_CODE_V2_INFO_PATH = '/api/info';

/**
 * Each dialect probe gets its own short deadline. The managed-service request
 * owner otherwise permits a request to remain open for its general five-minute
 * ceiling, so a stalled legacy route could prevent the V2 fallback probe from
 * ever running during session admission.
 */
const OPEN_CODE_DIALECT_PROBE_TIMEOUT_MS = 2_000;

/**
 * The liveness route for a resolved owned-server executable. The preview
 * `opencode2` exposes `/api/health`; released `opencode` 2.x exposes
 * `/api/info`. The V1 route is unchanged.
 *
 * One owner for "which health path belongs to this resolved server", shared by the
 * reachable-server probe below and the managed-service readiness declaration in
 * `spawnSpec.ts`, so the two can never disagree.
 */
export function openCodeServerHealthPath(dialect: OpenCodeServerDialect, executablePath?: string): string {
  if (dialect === 'v1') return OPEN_CODE_V1_HEALTH_PATH;
  const fileName = normalizeString(executablePath).split(/[/\\]/u).pop()?.replace(/\.(?:cmd|exe)$/iu, '').toLowerCase();
  return fileName && fileName !== OPEN_CODE_V2_EXECUTABLE_NAME
    ? OPEN_CODE_V2_INFO_PATH
    : OPEN_CODE_V2_HEALTH_PATH;
}

/**
 * The official name of the V2 beta executable, and the alternate lookup name of
 * the OpenCode system tool (`manifest.ts`). The pinned V1 repository names it
 * only in a diagnostic — `'... or run opencode2'`
 * (`packages/opencode/src/config/v2-compat.ts:111`) — because the beta ships on
 * its own distribution channel.
 */
export const OPEN_CODE_V2_EXECUTABLE_NAME = 'opencode2';

/**
 * Which liveness route an *owned* server will answer, read from the executable
 * the host actually resolved for it.
 *
 * The binary, not the requested transport, decides which routes the child
 * mounts: an `opencode2` child mounts no `/global/*` at all, so probing the
 * legacy route would leave a beta-only install permanently unhealthy and its
 * sessions unopenable. Conversely `HAPPIER_OPENCODE_SERVER_DIALECT=v2` must not
 * move readiness onto `/api/health`, because a stable server older than the
 * pinned 1.18.25 mounts no `/api` surface to answer it.
 *
 * Matching is on the exact resolved file name, extension-insensitive so a
 * Windows `PATHEXT` shim (`opencode2.cmd`) reads the same as a POSIX symlink.
 * A name that merely contains `opencode2` is not the beta.
 */
export function readOpenCodeManagedServerDialect(
  executablePath: string | null | undefined,
): OpenCodeServerDialect {
  const resolvedPath = normalizeString(executablePath);
  if (!resolvedPath) return 'v1';
  const fileName = resolvedPath.split(/[/\\]/u).pop() ?? '';
  const baseName = fileName.replace(/\.[^.]+$/u, '').toLowerCase();
  return baseName === OPEN_CODE_V2_EXECUTABLE_NAME ? 'v2' : 'v1';
}

/**
 * The V2 event stream. Unlike the V1 `/event` route it is not directory-scoped
 * (events carry `location` instead).
 *
 * It is a **live** stream with no resume contract. The pinned handler
 * (`packages/server/src/handlers/event.ts`) encodes every frame with
 * `id: undefined`, reads no request header, and subscribes a bounded live queue
 * (`EventV2.allBounded(events, 256)`) prefixed with one `server.connected`
 * frame. Events produced while no connection is open are not recoverable, so
 * Happier must not send `Last-Event-ID` or present a reconnect as replay.
 */
export const OPEN_CODE_V2_EVENT_PATH = '/api/event';

/**
 * The launch-environment key that opts a session into the V2 beta transport.
 *
 * `auto` (the default, and any unrecognised value) leaves the generation
 * undecided here. Owned servers resolve it from the selected executable and
 * its version; external servers use the bounded probes below. An explicit setting
 * still wins over this compatibility environment key.
 */
export const HAPPIER_OPENCODE_SERVER_DIALECT_ENV_KEY = 'HAPPIER_OPENCODE_SERVER_DIALECT';

export type OpenCodeRequestedServerDialect = 'auto' | 'v1' | 'v2';

export function readRequestedOpenCodeServerDialect(
  values: Readonly<Record<string, unknown>> | undefined,
): OpenCodeRequestedServerDialect {
  return normalizeString(values?.[HAPPIER_OPENCODE_SERVER_DIALECT_ENV_KEY]).toLowerCase() === 'v2'
    ? 'v2'
    : 'auto';
}

/**
 * Which dialect this session should ask for, from everything the host already
 * knows before the first request.
 *
 * `configuredGeneration` is the user's explicit Stable/V2 selection and is
 * authoritative for owned and external servers alike. `managedServerDialect`
 * is the generation of the executable Happier itself is
 * about to run, read by `readOpenCodeManagedServerDialect` from the resolved
 * system tool. When Happier owns an `opencode2` child it is not guessing: that
 * binary mounts `/api/*` and nothing else, so its readiness route and its
 * request routes must come from the same fact. Leaving such a session at `auto`
 * is what previously gave a managed beta server V2 readiness and V1 requests.
 *
 * With no explicit setting, a server Happier did not spawn (`null`) keeps the
 * launch-environment opt-in or remains auto for the detector.
 */
export function resolveRequestedOpenCodeServerDialect(params: Readonly<{
  configuredGeneration?: unknown;
  values: Readonly<Record<string, unknown>> | undefined;
  managedServerDialect: OpenCodeServerDialect | null;
}>): OpenCodeRequestedServerDialect {
  const configuredGeneration = normalizeString(params.configuredGeneration).toLowerCase();
  if (configuredGeneration === 'stable') return 'v1';
  if (configuredGeneration === 'v2') return 'v2';
  if (params.managedServerDialect === 'v2') return 'v2';
  return readRequestedOpenCodeServerDialect(params.values);
}

/**
 * Whether this launch carries Happier's connected-service request-auth
 * materialization — the generated `happier-request-auth-<provider>.js` plugin
 * Happier writes into the session's isolated OpenCode config home.
 *
 * That plugin is written against OpenCode's V1 plugin contract: a default-export
 * factory returning an `auth` hook whose `loader` supplies the provider `fetch`
 * (`agent/auth/services/requestAuth/source.ts`). OpenCode's V2 plugin contract
 * is a different shape — `{ id, setup(context) }` with a `PluginContext` of
 * `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`, `reference`
 * and `skill` hooks and **no `auth` hook**
 * (`comparators/opencode/packages/plugin/src/v2/promise/context.ts`). V2 moves
 * provider credentials to its `integration`/`credential` model instead.
 *
 * The pure V2 external loader accepts only a default `{ id, effect }` or
 * `{ id, setup }` object and ignores modules that fail that schema
 * (`packages/core/src/config/plugin/external.ts` at the pinned commit). A V1
 * callable factory is therefore incompatible, so admission must fail before
 * server supervision rather than launching with silently absent auth.
 */
export function usesOpenCodeConnectedServiceRequestAuth(
  values: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return normalizeString(values?.[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).length > 0;
}

export type OpenCodeServerDialectDetection = Readonly<{
  dialect: OpenCodeServerDialect;
  requested: OpenCodeRequestedServerDialect;
  /**
   * The observed probe outcome, or `null` when no probe was needed. Carried out
   * of the detector rather than logged inside it so the one caller can report
   * the decision on a default-on signal.
   */
  probe: Readonly<{
    path: string;
    status: number | null;
    error?: unknown;
  }> | null;
}>;

export function readsOpenCodeHealthyMarker(body: unknown): boolean {
  return asRecord(body)?.healthy === true;
}

/** OpenCode 2.0.15 replaced the preview health route with server.info. */
export function readsOpenCodeV2ServerInfo(body: unknown): boolean {
  const info = asRecord(body);
  return typeof info?.version === 'string'
    && info.version.length > 0
    && typeof info.pid === 'number'
    && Number.isInteger(info.pid)
    && info.pid >= 0
    && Array.isArray(info.urls)
    && asRecord(info.paths) !== null;
}

type OpenCodeHealthProbe = Readonly<{
  probe: NonNullable<OpenCodeServerDialectDetection['probe']>;
  body: unknown;
}>;

async function probeOpenCodeHealth(
  fetch: OpenCodeRuntimeFetch,
  path: string,
): Promise<OpenCodeHealthProbe> {
  try {
    const response = await fetch({
      url: path,
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      timeoutMs: OPEN_CODE_DIALECT_PROBE_TIMEOUT_MS,
    });
    if (!response.ok) return { probe: { path, status: response.status }, body: null };
    // A body that is not JSON — a proxy error page, say — is simply not an
    // answer to this question, and reaches the same safe result as a refusal.
    return { probe: { path, status: response.status }, body: await response.json().catch(() => null) };
  } catch (error) {
    return { probe: { path, status: null, error }, body: null };
  }
}

/**
 * Decide which dialect this session speaks to its OpenCode server.
 *
 * Explicit Stable and V2 selections are authoritative: readiness already used
 * the matching health route, and re-probing a dual-surface server would undo the
 * user's selection. Auto attach retains the official legacy-first probe order.
 *
 * An auto session is answered by probing in the official
 * discriminator's order (`packages/app/src/utils/server-protocol.ts`, pinned at
 * `70a24697ea0028e19f22712fd63059538cb4bee7`), on the route asymmetry the
 * pinned servers actually exhibit:
 *
 * 1. a healthy `/global/health` means V1, even if an `/api` surface also
 *    answers — only the stable binary mounts the legacy group, and it mounts
 *    the `/api/*` groups alongside it, so this correctly claims both the
 *    legacy-only and the both-generations server;
 * 2. otherwise a healthy `/api/health` means preview V2; when that route is
 *    absent, a shaped `/api/info` answer means released V2;
 * 3. anything else is V1.
 *
 * No `pid` is required, because no pinned server emits one (see
 * `OPEN_CODE_V2_HEALTH_PATH`). Requiring it made step 2 unreachable and left
 * `v2` permanently unselectable.
 *
 * One deliberate deviation from the official client: where it defaults an
 * undecided server to V2, Happier falls back to V1. Happier's request routes
 * are the V1 ones, so an unreachable or ambiguous probe must not move a session
 * off the transport that is proven against it. The caller reports which way it
 * went, including the deciding probe.
 */
export async function detectOpenCodeServerDialect(params: Readonly<{
  fetch: OpenCodeRuntimeFetch;
  requested: OpenCodeRequestedServerDialect;
}>): Promise<OpenCodeServerDialectDetection> {
  if (params.requested !== 'auto') {
    return { dialect: params.requested, requested: params.requested, probe: null };
  }
  const legacy = await probeOpenCodeHealth(params.fetch, OPEN_CODE_V1_HEALTH_PATH);
  if (readsOpenCodeHealthyMarker(legacy.body)) {
    return { dialect: 'v1', requested: params.requested, probe: legacy.probe };
  }
  const current = await probeOpenCodeHealth(params.fetch, OPEN_CODE_V2_HEALTH_PATH);
  if (current.probe.status === 404 || current.probe.status === 405) {
    const info = await probeOpenCodeHealth(params.fetch, OPEN_CODE_V2_INFO_PATH);
    if (readsOpenCodeV2ServerInfo(info.body)) {
      return { dialect: 'v2', requested: params.requested, probe: info.probe };
    }
  }
  return {
    dialect: readsOpenCodeHealthyMarker(current.body) ? 'v2' : 'v1',
    requested: params.requested,
    probe: current.probe,
  };
}

/**
 * Normalize one released V2 event from the single `/api/event` stream into the
 * runtime domain the OpenCode projection already consumes.
 *
 * The V2 envelope is `{ id, type, data, location?, durable? }` while the V1
 * instance stream emits `{ type, properties }`. Released `/api/event` carries
 * both durable and live frames, so there is no second history/session stream.
 *
 * Returns `null` for an event that is not addressed to this session's
 * directory, or that carries no usable type.
 */
export function normalizeOpenCodeV2InstanceEvent(
  rawEvent: unknown,
  directory: string | null,
): OpenCodeGlobalEvent | null {
  const record = asRecord(rawEvent);
  const type = normalizeString(record?.type);
  if (!type) return null;

  // The V2 stream is server-wide. `location.directory` is the only scoping the
  // server offers, so an event that names a different directory is not ours.
  // An event without a location (the `server.connected` boundary, and any
  // instance-wide notice) stays addressed to every subscriber, exactly as the
  // V1 directory-scoped stream delivered it.
  const eventDirectory = normalizeString(asRecord(record?.location)?.directory);
  if (directory && eventDirectory && eventDirectory !== directory) return null;

  const normalized = normalizeOpenCodeV2Event(type, record?.data);
  return { type: normalized.type, properties: normalized.properties };
}

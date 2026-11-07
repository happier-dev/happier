import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';

type NativeConfiguration = Readonly<Record<string, ProtocolJsonValue>>;
type NativeRule = NativeConfiguration & Readonly<{ service: string; hostname?: string; path?: string }>;
export type OwnedHostname = Readonly<{ hostname: string; path?: string; expectedService: string }>;
export type DesiredHostname = Readonly<{ hostname: string; path?: string; service: string }>;
export type IngressChange =
  | Readonly<{ kind: 'prepared'; config: NativeConfiguration }>
  | Readonly<{ kind: 'refused'; code: 'route_conflict' }>;

function nativeRule(value: ProtocolJsonValue): value is NativeRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // Array.isArray does not narrow the SDK's readonly-array union; the existing
  // JSON object check above establishes this record before its fields narrow.
  const record = value as NativeConfiguration;
  return typeof record.service === 'string' && record.service.length > 0
    && (record.hostname === undefined || typeof record.hostname === 'string')
    && (record.path === undefined || typeof record.path === 'string');
}

function routeKey(route: Readonly<{ hostname?: string; path?: string }>) {
  return JSON.stringify([route.hostname?.toLowerCase() ?? null, route.path ?? null]);
}

function wildcardMatches(pattern: string, hostname: string): boolean {
  return pattern === '*' || pattern.startsWith('*.') && hostname.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
}

/** P21 owned-route merge; foreign route order and native options remain intact. */
export function prepareOwnedCloudflareIngress(input: Readonly<{
  config: NativeConfiguration;
  owned: readonly OwnedHostname[];
  desired: readonly DesiredHostname[];
}>): IngressChange {
  const conflict = { kind: 'refused', code: 'route_conflict' } as const;
  const raw = input.config.ingress ?? [];
  if (!Array.isArray(raw)) return conflict;
  const rules: NativeRule[] = [];
  for (const value of raw) {
    if (!nativeRule(value)) return conflict;
    rules.push(value);
  }
  // Removing nothing from an empty remote config must not create a catch-all.
  if (rules.length === 0 && input.desired.length === 0) return { kind: 'prepared', config: input.config };
  const catchAll = rules.filter(rule => rule.hostname === undefined && rule.path === undefined);
  // Preserve a foreign effective default, including its service and options.
  // Only an empty new remote config acquires the native example's 404 default.
  if (rules.length > 0 && (catchAll.length !== 1 || catchAll[0] !== rules.at(-1))) return conflict;
  const fallback = catchAll[0] ?? { service: 'http_status:404' };
  const routes = rules.filter(rule => rule !== catchAll[0]);
  const owned = new Map(input.owned.map(route => [routeKey(route), route]));
  const desired = new Map(input.desired.map(route => [routeKey(route), route]));
  if (owned.size !== input.owned.length || desired.size !== input.desired.length) return conflict;
  const seen = new Set<string>();
  const next: NativeRule[] = [];
  for (const rule of routes) {
    const key = routeKey(rule);
    if (seen.has(key)) return conflict;
    seen.add(key);
    const previous = owned.get(key);
    const replacement = desired.get(key);
    if (previous) {
      if (rule.service !== previous.expectedService) return conflict;
      if (replacement) {
        next.push(rule.service === replacement.service ? rule : { ...rule, service: replacement.service });
        desired.delete(key);
      }
    } else {
      if (replacement) return conflict;
      // An earlier wildcard can shadow an exact requested hostname. Preserve
      // that foreign rule; refuse rather than report a route we did not gain.
      if (input.desired.some(route => {
        const targetIndex = routes.findIndex(candidate => routeKey(candidate) === routeKey(route));
        const comesFirst = targetIndex < 0 || routes.indexOf(rule) < targetIndex;
        return comesFirst && (rule.hostname === undefined || wildcardMatches(rule.hostname, route.hostname)
          || rule.hostname.toLowerCase() === route.hostname.toLowerCase() && rule.path === undefined);
      })) return conflict;
      next.push(rule);
    }
  }
  for (const route of desired.values()) next.push({ ...route });
  next.push(fallback);
  const unchanged = next.length === rules.length && next.every((rule, index) => rule === rules[index]);
  return { kind: 'prepared', config: unchanged ? input.config : { ...input.config, ingress: next } };
}

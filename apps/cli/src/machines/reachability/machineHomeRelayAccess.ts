import { normalizeRelayAccessCanonicalPublicServerUrl, readLocalRelayAccessConfig,
  writeLocalRelayAccessConfig } from '@happier-dev/cli-common/relayAccess';
import { projectRelayAccessConfigV1, type RelayAccessTaskSnapshotV1 } from '@happier-dev/protocol/system/tasks/relayAccessConfigV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { MachineReachabilityInspectInputV1 } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { readRelayRuntimeStatus } from '@/capabilities/systemTasks/relayRuntime/liveRelayRuntime';
import { observeServerFeaturesSnapshot, readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { createReachabilityProviderHost, HomeRelayRoleTarget } from './reachabilityProviderHost';

export function readMachineHomeRelayDemand(input: MachineReachabilityInspectInputV1) {
  if (input.change?.kind === 'homeRelay') return { relay: input.change.relay, hostname: input.change.hostname };
  return input.homeRelay ? { relay: input.homeRelay } : null;
}

/** Resolve this enrolled Machine's actual Relay. A client cannot supply an upstream. */
export async function readMachineHomeRelayTarget(input: Readonly<{
  demand: NonNullable<ReturnType<typeof readMachineHomeRelayDemand>>;
  homeIdentity: string | null;
  homeDir: string;
  signal?: AbortSignal;
}>): Promise<HomeRelayRoleTarget | null> {
  if (!input.homeIdentity) return null;
  const { demand, homeDir, signal, homeIdentity } = input;
  const runtime = await readRelayRuntimeStatus({ target: { kind: 'local' }, ...demand.relay, signal });
  const upstream = runtime.installed ? normalizeRelayAccessCanonicalPublicServerUrl(runtime.baseUrl) : null;
  if (!upstream) return null;
  const identity = await observeServerFeaturesSnapshot({ serverUrl: upstream, signal });
  if (readServerIdentityIdFromFeaturesSnapshot(identity) !== homeIdentity) return null;
  const record = await readLocalRelayAccessConfig(homeDir);
  const currentRoute = record?.route;
  if (currentRoute && (currentRoute.ownerId !== homeIdentity || currentRoute.upstream !== upstream)) return null;
  const hostname = demand.hostname ?? currentRoute?.hostname ?? new URL(upstream).hostname;
  if (!URL.canParse(`https://${hostname}`) || new URL(`https://${hostname}`).hostname !== hostname.toLowerCase()) return null;
  return { route: { ownerId: homeIdentity, upstream, hostname, httpsPort: 443, path: '/' },
    currentSelection: record?.selection ?? null, ...(currentRoute ? { currentRoute } : {}) };
}

type ProviderHost = ReturnType<typeof createReachabilityProviderHost>;
export async function readMachineHomeRelayAccess(target: HomeRelayRoleTarget, providers: ProviderHost): Promise<RelayAccessTaskSnapshotV1> {
  const selection = target.currentSelection;
  if (!selection) return { configured: false, providerId: null, selection: null,
    status: { state: 'disabled', shareUrl: null, details: null } };
  const outcome = await providers.invoke(selection, 'inspect', { target: 'homeRelay', route: target.currentRoute ?? target.route });
  return projectRelaySnapshot(selection, outcome);
}

export async function applyMachineHomeRelayAccess(input: Readonly<{
  target: HomeRelayRoleTarget;
  selection: AccessProviderSelectionV1 | null;
  providers: ProviderHost;
  homeDir: string;
}>) {
  const { target, selection, providers, homeDir } = input;
  const current = await readLocalRelayAccessConfig(homeDir);
  if (!sameStrictJsonValue(current, target.currentSelection ? { selection: target.currentSelection,
    ...(target.currentRoute ? { route: target.currentRoute } : {}) } : null)) {
    return { ok: false as const, errorCode: 'plan_changed', error: 'plan_changed', effectAttempted: false };
  }
  const effectSelection = selection ?? target.currentSelection;
  if (!effectSelection) return { ok: true as const, status: 'unchanged' as const, relayAccess: await readMachineHomeRelayAccess(target, providers) };
  const role = selection ? 'configure' : 'disable';
  const route = selection ? target.route : target.currentRoute ?? target.route;
  const outcome = await providers.invoke(effectSelection, role, { target: 'homeRelay', route });
  if (!outcome.ok) return outcome;
  if (outcome.result.kind === 'refused') return { ok: false as const, errorCode: outcome.result.code,
    error: outcome.result.code, effectAttempted: false };
  if (outcome.result.kind === 'unknown') return { ok: true as const, status: 'outcome_unknown' as const,
    errorCode: outcome.result.code, relayAccess: { ...projectRelaySnapshot(effectSelection, outcome),
      configured: !!target.currentSelection, selection: projectRelayAccessConfigV1(target.currentSelection) } };
  const { state } = outcome.result.facts;
  if (state === 'unknown' || state === 'unavailable' || !selection && state !== 'stopped') return { ok: true as const, status: 'outcome_unknown' as const,
    errorCode: 'invalid_provider_output', relayAccess: projectRelaySnapshot(effectSelection, outcome) };
  try {
    await writeLocalRelayAccessConfig(homeDir, selection ? { selection, route } : null);
  } catch {
    return { ok: true as const, status: 'outcome_unknown' as const, errorCode: 'relay_access_persistence_unavailable',
      relayAccess: projectRelaySnapshot(effectSelection, outcome) };
  }
  return { ok: true as const, status: 'applied' as const,
    relayAccess: selection ? projectRelaySnapshot(selection, outcome) : await readMachineHomeRelayAccess({ ...target, currentSelection: null }, providers) };
}

function projectRelaySnapshot(selection: AccessProviderSelectionV1, outcome: Awaited<ReturnType<ProviderHost['invoke']>>): RelayAccessTaskSnapshotV1 {
  const facts = outcome.ok && outcome.result.kind === 'confirmed' ? outcome.result.facts : null;
  const code = outcome.ok ? outcome.result.kind === 'confirmed' ? null : outcome.result.code : outcome.errorCode;
  const providerId = 'kind' in selection.provider ? selection.provider.id : buildQualifiedPluginContributionKey(selection.provider);
  const state = facts?.state === 'ready' ? 'enabled' : facts?.state === 'stopped' ? 'disabled'
    : facts?.state === 'needsAuth' ? 'needs_auth' : code || facts?.state === 'unavailable' ? 'error' : 'unknown';
  const approvalUrl = state === 'needs_auth' ? normalizeRelayAccessCanonicalPublicServerUrl(facts?.authorizationUrl) : null;
  return { configured: true, providerId, selection: projectRelayAccessConfigV1(selection), status: {
    state, shareUrl: normalizeRelayAccessCanonicalPublicServerUrl(facts?.publicUrl),
    details: approvalUrl?.startsWith('https://') ? { approvalUrl } : code ? { code } : null,
  } };
}

/** Prevent an unprojectable bootstrap secret from being carried into review artifacts. */
export function canReviewMachineHomeRelaySelection(selection: AccessProviderSelectionV1 | null): boolean {
  return !selection || sameStrictJsonValue(selection, projectRelayAccessConfigV1(selection));
}

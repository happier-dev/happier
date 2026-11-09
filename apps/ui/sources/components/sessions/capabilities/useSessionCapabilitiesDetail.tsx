import * as React from 'react';
import { getAgentCore, isBundledAgentId, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { MetadataSchema } from '@happier-dev/session-core/state';
import type { Message } from '@happier-dev/session-core/messages';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { CapabilityCost } from '@/components/capabilities/facts/CapabilityFacts';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { findMcpSignInGrant, mcpSignInFact, mcpSignInGrantView } from '@/components/settings/mcpServers/signIn/mcpSignInGrantView';
import { useMcpSignInGrantDiagnostics } from '@/components/settings/mcpServers/signIn/useMcpSignInGrantDiagnostics';
import { useMcpServerSignIn } from '@/components/settings/mcpServers/signIn/useMcpServerSignIn';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { mcpServerStatus } from '@/components/settings/mcpServers/status/mcpServerStatus';
import { skillStatus } from '@/components/settings/skills/status/skillStatus';
import { useSkillPlaces } from '@/components/settings/skills/useSkillPlaces';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useFoundSkillsCache } from '@/sync/domains/skills/useFoundSkills';
import { skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { useReachRulesLookup } from '@/sync/store/useReachRulesCatalog';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import type { SessionCapabilitiesLastKnown, SessionCapabilitiesModelInput } from './sessionCapabilitiesModel';
import type { NewSessionCapabilitiesDraft } from './useSessionCapabilitiesPopover';

export type Detail = Pick<SessionCapabilitiesModelInput, 'rules' | 'mcpStatus' | 'skillStatus' | 'names' | 'context' | 'nativeSkills' | 'cost'>;
export type SheetTarget = Readonly<{ sessionId?: string; metadata?: unknown; draft?: Pick<NewSessionCapabilitiesDraft, 'machineId' | 'directory' | 'agentId' | 'projectKey'> }>;
export type ModelInput = Pick<SessionCapabilitiesModelInput, 'view' | 'selection' | 'state' | 'readOnly' | 'change' | 'applyState'>;
const EMPTY_MESSAGES: Readonly<Record<string, Message>> = Object.freeze({});

const NO_RULES: ReturnType<Detail['rules']> = [];
const NO_STATUSES: ReturnType<Detail['mcpStatus']> = [];
/**
 * The always-mounted chip needs no rules, statuses or names: its counts come from the preview alone.
 * The detail owners mount only in the open sheet, which reports back the one summary fact the closed
 * chip shows (its attention dot).
 */
export const CLOSED_DETAIL: Detail = {
  rules: () => NO_RULES,
  mcpStatus: () => NO_STATUSES,
  skillStatus: () => NO_STATUSES,
  names: {
    agentName: (id) => id,
    agentNames: (ids) => ids,
    machineName: (id) => id,
    projectName: (key) => key,
    folderLabel: (_machineId, root) => root,
  },
};

/**
 * The sheet's detail inputs, from their canonical owners: rules from the Account rows (P2), skill and MCP
 * statuses from P6/P7's status owners, names from the places owner.
 */
export function useSessionCapabilitiesDetail(
  serverId: string | null,
  machineOnline: boolean | null,
  onFactsChanged: (factsKey: string) => void,
  target: SheetTarget,
  modelInput: ModelInput,
  machineName: string,
  /** The cost facts the sheet last knew: shown while the Account rows they come from are read again. */
  lastKnownCosts?: SessionCapabilitiesLastKnown['costs'],
  demand?: Readonly<{ skillIds: readonly string[]; enabled: boolean }>,
) {
  const router = useRouter();
  const active = useActiveServerSnapshot(!serverId);
  const { binding } = useServerCredentialAccountScopeBinding(
    serverId ?? active.serverId,
  );
  const scope = binding?.scope ?? null;
  const { rules, skillRules, mcpCatalog } = useReachRulesLookup(scope);
  const savedSecretCatalog = useSavedSecretCatalog({ scope });
  // The Account's sign-in grants (P7's one reading of a grant): a row says "Sign-in expired" or
  // "Sign in" with its fix, as the server page does when no attempt is running.
  const grants = getStorage()((state) => areServerAccountScopesEqual(scope, state.profileScope) ? state.profile.connectedAccountsV4 : null);
  const reach = useReachMachines();
  const parsedMetadata = React.useMemo(() => MetadataSchema.safeParse(target.metadata), [target.metadata]);
  const metadata = parsedMetadata.success ? parsedMetadata.data : null;
  const nativeCatalogInput = metadata ? Reflect.get(metadata, 'sessionSkillCatalogV1') : undefined;
  const machineId = target.draft?.machineId ?? metadata?.machineId ?? null;
  const machine = areServerAccountScopesEqual(scope, reach.scope) ? reach.machines.find(row => row.machineId === machineId) : null;
  const agentId = target.draft?.agentId ?? (metadata ? resolveAgentIdFromSessionMetadata(metadata) : null);
  const diagnostics = useMcpSignInGrantDiagnostics(grants, scope);
  const library = useSkillsLibrary(scope, demand);
  // The open detail leaf observes the actual Account inputs; callback identity is not a fact.
  const factsKey = JSON.stringify([scope?.serverId, scope?.accountId, skillRules, mcpCatalog, machineId, agentId,
    metadata?.path, metadata?.workspaceId, metadata?.projectId, modelInput.selection,
    demand ? null : library.items.map(item => [item.skillId, item.revision])]);
  const observedFacts = React.useRef(factsKey);
  const factsChanged = React.useRef(onFactsChanged);
  factsChanged.current = onFactsChanged;
  React.useEffect(() => {
    if (observedFacts.current === factsKey) return;
    observedFacts.current = factsKey;
    factsChanged.current(factsKey);
  }, [factsKey]);
  const { names, workspaceRefs } = useSkillPlaces(scope?.serverId ?? serverId);
  const context = React.useMemo(() => {
    if (!machineId || !scope) return undefined;
    const candidatePath = target.draft?.directory ?? metadata?.path ?? '';
    const directory = metadata ? resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath }).machinePath : candidatePath;
    const project = resolveSessionProjectKeyV1(metadata ?? {}, scope.serverId, workspaceRefs,
      { ...workspaceRefResolutionContextV1(), projectKey: target.draft?.projectKey });
    // Until the accepted Project association is available, keep the Machine's resolved preview.
    if (project.kind === 'unavailable') return undefined;
    const projectKey = project.kind === 'resolved' ? project.projectKey.projectKey : null;
    return { machineId, machinePlatform: modelInput.view && 'machinePlatform' in modelInput.view ? modelInput.view.machinePlatform : machine?.platform ?? null,
      directory: directory || null, projectKey, agentId };
  }, [machineId, target.draft?.directory, target.draft?.projectKey, metadata, scope, workspaceRefs, modelInput.view, machine?.platform, agentId]);
  const ids = React.useMemo(() => machineId ? [machineId] : [], [machineId]);
  const found = useFoundSkillsCache(ids, scope);
  const nativeSkills = React.useMemo(() => {
    if (!machineId || !agentId) return undefined;
    const catalog = SessionSkillCatalogListResponseV1Schema.safeParse(nativeCatalogInput);
    const items = new Map<string, Readonly<{ name: string; path: string }>>();
    // A Session's published catalog takes precedence over last-known Machine Found facts.
    if (catalog.success) {
      for (const item of catalog.data.skills) {
        if (item.origin === 'vendor' && item.path && (!item.backendId || item.backendId === agentId)) items.set(item.name, { name: item.name, path: item.path });
      }
    } else {
      for (const item of found[machineId]?.items ?? []) {
        if (item.agents.some(agent => agent === agentId) && !item.happierInstalled && item.scope === 'user') items.set(item.name, { name: item.name, path: item.path });
      }
    }
    for (const item of modelInput.view?.skills.plan.nativeDisables ?? []) if (!items.has(item.name)) items.set(item.name, { name: item.name, path: item.path });
    const declaration = machine?.agentDeclarationsById?.[agentId]?.capabilities?.skills;
    const bundled = !machine?.agentDeclarationsById && isBundledAgentId(agentId) ? getAgentCore(agentId)?.skills : null;
    return { items: [...items.values()], canDisable: (declaration ?? bundled)?.nativeDisable === 'supported',
      machineName, agentName: names.agentName(agentId), applyTiming: modelInput.applyState?.applyTiming?.mcp ?? modelInput.view?.applyTiming.mcp ?? { t: 'session_not_running' as const } };
  }, [machineId, agentId, nativeCatalogInput, found, modelInput.view?.skills.plan, modelInput.view?.applyTiming.mcp,
    modelInput.applyState?.applyTiming?.mcp, machine?.agentDeclarationsById, machineName, names]);
  const messages = getStorage()(state => target.sessionId && areServerAccountScopesEqual(scope, state.sessionLocalStateScope)
    ? state.sessionMessages[target.sessionId]?.messagesById ?? EMPTY_MESSAGES : EMPTY_MESSAGES);
  const notices = React.useMemo(() => Object.values(messages).flatMap(message => {
    const notice = message.kind === 'agent-event' ? readSessionCapabilityNoticeV1(message.event) : null;
    return notice ? [notice] : [];
  }), [messages]);
  const servers = React.useMemo(
    () =>
      new Map((mcpCatalog?.servers ?? []).map((entry) => [entry.id, entry])),
    [mcpCatalog],
  );
  const skills = React.useMemo(
    () => new Map(library.items.map((item) => [item.skillId, item])),
    [library.items],
  );
  const [signInRequest, setSignInRequest] = React.useState<Readonly<{ id: string; stepUp: boolean }> | null>(null);
  const signInMachines = React.useMemo(() => machineId ? [{ machineId, name: machineName, online: machineOnline }] : [], [machineId, machineName, machineOnline]);
  const signIn = useMcpServerSignIn(signInRequest ? servers.get(signInRequest.id) ?? null : null, signInMachines, {
    scope, ...(target.sessionId ? { returnTo: `/session/${encodeURIComponent(target.sessionId)}?serverId=${encodeURIComponent(scope?.serverId ?? '')}&capabilities=open` } : {}),
  });
  const startSignIn = React.useRef(signIn.start);
  startSignIn.current = signIn.start;
  React.useEffect(() => { if (signInRequest) void startSignIn.current({ stepUp: signInRequest.stepUp }); }, [signInRequest]);
  const freshCost = React.useCallback((kind: 'skill' | 'mcp_server', id: string): CapabilityCost | null => {
    if (kind === 'skill') {
      const cost = skills.get(id)?.cost;
      return cost ? { tokensWhenUsed: cost.bodyTokens } : null;
    }
    const entry = servers.get(id);
    const snapshot = entry?.toolsSnapshot;
    if (!entry || !snapshot) return null;
    const toolsDeclaration = agentId ? machine?.agentDeclarationsById?.[agentId]?.capabilities?.tools
      ?? (!machine?.agentDeclarationsById && isBundledAgentId(agentId) ? getAgentCore(agentId)?.tools : null) : null;
    const hidesOff = toolsDeclaration?.mcpToolControl?.off === 'hidden';
    const tools = snapshot.tools.filter(tool => !hidesOff || resolveMcpToolDecisionV1({ policy: entry.tools, toolName: tool.name,
      annotations: tool.annotations, permissionMode: 'default' }).exposed);
    return { toolCount: tools.length, tokensPerTurn: tools.reduce((sum, tool) => sum + tool.tokens, 0) };
  }, [skills, servers, agentId, machine?.agentDeclarationsById]);
  const detail = React.useMemo<Detail>(
    () => ({
      rules,
      names,
      context,
      nativeSkills,
      cost: (kind, id) => freshCost(kind, id) ?? lastKnownCosts?.get(`${kind}:${id}`) ?? null,
      skillStatus: (skillId) => {
        const item = skills.get(skillId);
        return skillStatus(item ?? null, undefined, { skillId, plan: modelInput.view?.skills.plan ?? null, notices, machineName,
          onFix: () => router.push(skillHref(skillId) as never) });
      },
      mcpStatus: (serverId) => {
        const entry = servers.get(serverId);
        if (!entry) return NO_STATUSES;
        const open = () => router.push(mcpServerRoute(serverId) as never);
        return mcpServerStatus({
          entry,
          signIn: signInRequest?.id === serverId ? signIn.fact : mcpSignInFact(
            mcpSignInGrantView(
              entry,
              findMcpSignInGrant(grants, serverId),
              machineOnline,
              diagnostics[serverId],
            ),
          ),
          tests: {},
          machines: signInMachines,
          sessionNotices: notices,
          savedSecretCatalog,
          fixes: {
            signIn: () => setSignInRequest({ id: serverId, stepUp: false }),
            reconnect: () => setSignInRequest({ id: serverId, stepUp: false }),
            grantAccess: () => setSignInRequest({ id: serverId, stepUp: true }),
            addKey: open,
            howToFix: open,
            tryAgain: open,
          },
        });
      },
    }),
    [context, nativeSkills, freshCost, lastKnownCosts, notices, machineName, modelInput.view?.skills.plan, signInRequest, signIn.fact,
      signInMachines, diagnostics, rules, names, skills, servers, savedSecretCatalog, grants, machineOnline, router],
  );
  const renderMark = React.useCallback(
    (id: string) => (
      <HappierBrandMark
        brand={{ displayName: servers.get(id)?.title ?? servers.get(id)?.name ?? id }} externallyLabelled
        pixelSize={20}
      />
    ),
    [servers],
  );
  return { detail, renderMark, library };
}


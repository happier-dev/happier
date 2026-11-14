import type { ProcessCensusSnapshot, ProcessPrincipal } from '@/processes/census/processCensus';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import { parseHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { parseWindowsJobCustodyOwnerTag } from '@/subprocess/supervision/processCustody';
import { compareProcessPrincipals } from '@/processes/ownership/principal';
import { ancestorsOf, indexCensus } from '@/processes/tree/processTree';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot, type ListenerFact, type ResolvedProcessOwnership, type ProcessEvidence } from './types';
import { resolveProcessOwnershipLevel } from './levelRules';
export type { HappierProcessRoot, ProcessOwnerRef, ProcessEvidence, ProcessOwnershipLevel, ResolvedProcessOwnership } from './types';

export function resolveProcessOwnership(input: Readonly<{
    snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>;
    roots: readonly HappierProcessRoot[];
    daemonPrincipal: ProcessPrincipal | null;
    daemonScopeKey?: string;
    platform?: NodeJS.Platform;
    listeners?: readonly ListenerFact[];
    capturedOwnership?: readonly ResolvedProcessOwnership[];
}>): readonly ResolvedProcessOwnership[] {
    const platform = input.platform ?? process.platform;
    const index = indexCensus(input.snapshot.rows);
    const rootsByOwner = new Map<string, HappierProcessRoot>();
    const liveByPid = new Map<number, HappierProcessRoot[]>();
    const ordinaryFenceRoots: HappierProcessRoot[] = [];
    const nativePrefixes = new Map<string, Readonly<{ root: HappierProcessRoot; prefix: string }> | null>();
    for (const root of input.roots) {
        if (root.owner.kind !== 'container') ordinaryFenceRoots.push(root);
        const previous = rootsByOwner.get(processOwnerKey(root.owner));
        if (!previous || root.live && !previous.live) rootsByOwner.set(processOwnerKey(root.owner), root);
        const current = index.byPid.get(root.pid);
        if (root.live && current && equalProcessStart(current.start, root.start)) {
            const roots = liveByPid.get(root.pid) ?? [];
            roots.push(root); liveByPid.set(root.pid, roots);
            const containment = root.containment;
            if (platform === 'linux' && root.owner.kind === 'container' && containment?.kind === 'linux_container') {
                const previous = nativePrefixes.get(containment.prefix);
                nativePrefixes.set(containment.prefix, previous === null
                    || previous && processOwnerKey(previous.root.owner) !== processOwnerKey(root.owner) ? null : { root, prefix: containment.prefix });
            }
        }
    }
    const listening = new Set(input.listeners?.flatMap(item => item.pid === undefined ? [] : [item.pid]) ?? []);
    const captured = new Map(input.capturedOwnership?.map(item => [item.pid, item]) ?? []);
    const partial = new Map(input.snapshot.partial?.map(item => [item.pid, item.missing]) ?? []);
    const baseResults: ResolvedProcessOwnership[] = input.snapshot.rows.map(row => {
        const principal = compareProcessPrincipals(row.principal, input.daemonPrincipal);
        const lineage = [row, ...ancestorsOf(index, row.pid)];
        const evidence: ProcessEvidence[] = [
            { kind: 'fence', state: 'not_available', reason: platform === 'darwin' ? 'macos_no_fence' : platform === 'win32' ? 'job_join_failed' : 'no_systemd_user_manager' },
            { kind: 'parent_chain', state: 'not_met', reason: 'no_live_root' },
            { kind: 'marker', state: 'not_met', reason: 'marker_cleared' },
            { kind: 'group_and_port', state: 'not_met', reason: 'no_group_or_port_match' },
        ];
        let nativeFence: Readonly<{ root: HappierProcessRoot; prefix: string }> | null | undefined;
        // Deepest admitted cgroup wins, including a genuinely nested container.
        // The immutable native root facts are indexed once, never rescanned per process.
        if (nativePrefixes.size) for (let path = row.cgroup; path && nativeFence === undefined; path = path.slice(0, path.lastIndexOf('/'))) {
            nativeFence = nativePrefixes.get(path);
        }
        const nativeConflict = nativeFence === null;
        const nativePrefix = nativeFence?.prefix;
        const outsideNativeFence = nativePrefix ? lineage.findIndex(item => item.cgroup !== nativePrefix
            && !item.cgroup?.startsWith(`${nativePrefix}/`)) : -1;
        const chain = [...(outsideNativeFence < 0 ? lineage : lineage.slice(0, outsideNativeFence))]
            .reverse().map(item => ({ pid: item.pid, name: item.name }));
        let fence = nativeFence?.root;
        let parent: HappierProcessRoot | undefined;
        let marker: HappierProcessRoot | undefined;
        let markerUnknown = nativeConflict;
        if (principal === 'self' && nativeFence === undefined) {
            fence = ordinaryFenceRoots.find(root => root.containment?.kind === 'linux_unit'
                ? row.cgroup === root.containment.prefix || row.cgroup?.startsWith(`${root.containment.prefix.replace(/\/+$/u, '')}/`)
                : root.containment?.kind === 'windows_job' && row.jobs?.includes(root.containment.name));
            // A native fence survives its spawning root. Decode only the canonical
            // platform name and join it to a known lifecycle owner in this home.
            const fenceTags = platform === 'linux'
                ? (row.cgroup?.split('/').reverse().map(parseHappierLinuxScopeName) ?? [])
                : platform === 'win32' ? (row.jobs?.map(name => parseProcessOwnerTag(parseWindowsJobCustodyOwnerTag(name))) ?? []) : [];
            for (const tag of fence ? [] : fenceTags) {
                if (!tag || tag.daemonScopeKey !== input.daemonScopeKey) continue;
                const candidate = rootsByOwner.get(processOwnerKey(tag.owner));
                if (candidate) { fence = candidate; break; }
                markerUnknown = true;
            }
            if (fence) evidence[0] = { kind: 'fence', state: 'met', reason: platform === 'win32' ? 'windows_job' : 'linux_scope' };
            else if (row.cgroup || row.jobs) evidence[0] = { kind: 'fence', state: 'not_met', reason: 'outside_fence' };
            // The nearest live root decides. A session host carries one live root per hosted
            // Session, so it is no single Session's chain: its own tag and each Agent's
            // tag or fence decide instead, never an arbitrary first hosted Session.
            for (const item of lineage) {
                const candidates = (liveByPid.get(item.pid) ?? []).filter(root => root.owner.kind !== 'container' && row.start.startTimeMs >= root.start.startTimeMs);
                if (!candidates.length) continue;
                if (new Set(candidates.map(root => processOwnerKey(root.owner))).size === 1) parent = candidates[0];
                break;
            }
            if (parent) evidence[1] = { kind: 'parent_chain', state: 'met', reason: 'live_root_chain' };
            {
                const tagged = lineage.find(item => item.ownerTag !== undefined);
                const parsed = parseProcessOwnerTag(tagged?.ownerTag);
                if (parsed) {
                    if (parsed.daemonScopeKey !== input.daemonScopeKey) evidence[2] = { kind: 'marker', state: 'not_met', reason: 'foreign_home_marker' };
                    else {
                        // Named components reuse a fixed tag across generations. The
                        // nearest exact native root wins over another live incarnation.
                        const fixedDomain = parsed.owner.kind === 'happier' || parsed.owner.kind === 'browser_sidecar' || parsed.owner.kind === 'workspace_sync';
                        const candidate = (fixedDomain ? lineage.flatMap(item => input.roots.filter(root => root.pid === item.pid
                            && equalProcessStart(root.start, item.start) && processOwnerKey(root.owner) === processOwnerKey(parsed.owner)))[0] : undefined)
                            ?? rootsByOwner.get(processOwnerKey(parsed.owner));
                        if (!candidate) {
                            markerUnknown = true;
                            evidence[2] = { kind: 'marker', state: 'not_available', reason: 'marker_owner_unknown' };
                        } else {
                            const created = platform === 'linux' ? candidate.ownerCreatedStartTimeMs : candidate.ownerCreatedAtMs;
                            if (created === undefined) {
                                markerUnknown = true;
                                evidence[2] = { kind: 'marker', state: 'not_available', reason: 'required_fields_unreadable' };
                            } else if (row.start.startTimeMs >= created) {
                                marker = candidate;
                                evidence[2] = { kind: 'marker', state: 'met', reason: 'marker_matches' };
                            } else evidence[2] = { kind: 'marker', state: 'not_met', reason: 'marker_predates_owner' };
                        }
                    }
                }
            }
        }
        if (fence?.owner.kind === 'container') evidence[0] = { kind: 'fence', state: 'met', reason: 'linux_container' };
        let selected = fence ?? parent ?? marker;
        // A lifecycle owner can end one captured subtree while its daemon owner
        // remains live. Only the exact native generation is ended; a shared tag
        // or another member of the same process group does not inherit that fact.
        const exactEnded = principal === 'self' && !liveByPid.has(row.pid)
            ? input.roots.find(root => !root.live && root.pid === row.pid && equalProcessStart(root.start, row.start)
                && (!selected || processOwnerKey(root.owner) === processOwnerKey(selected.owner))) : undefined;
        if (exactEnded) {
            selected = exactEnded;
            evidence[1] = { kind: 'parent_chain', state: 'met', reason: 'chain_broken_at_exit',
                at: { pid: exactEnded.pid, ...(exactEnded.endedAtMs === undefined ? {} : { exitedAtMs: exactEnded.endedAtMs }) } };
        }
        // A session swap keeps the physical launch fence but transfers this exact
        // runner generation. Do not let the ended launch owner reclaim its live
        // replacement (or descendants) merely because that fence cannot be renamed.
        if (fence && !fence.live && parent && processOwnerKey(parent.owner) !== processOwnerKey(fence.owner)
            && parent.pid === fence.pid && equalProcessStart(parent.start, fence.start)) selected = parent;
        // Runs have their own invoking runtime inside a Session's hosting process/fence.
        if (marker?.owner.kind === 'run' && (!selected || selected.owner.kind === 'session'
            && (!marker.owner.sessionId || marker.owner.sessionId === selected.owner.sessionId))) selected = marker;
        const prior = captured.get(row.pid);
        if (!selected && principal === 'self' && prior?.owner && equalProcessStart(prior.start, row.start)
            && prior.evidence.some(item => item.kind === 'parent_chain' && item.state === 'met')) {
            const ended = rootsByOwner.get(processOwnerKey(prior.owner));
            if (ended && !ended.live) {
                selected = ended;
                evidence[1] = { kind: 'parent_chain', state: 'met', reason: 'chain_broken_at_exit',
                    at: { pid: ended.pid, ...(ended.endedAtMs === undefined ? {} : { exitedAtMs: ended.endedAtMs }) } };
            }
        }
        const ownerEnded = selected ? !selected.live : false;
        const missing = partial.get(row.pid) ?? [];
        const observationsIncomplete = markerUnknown || missing.some(field => ['principal', 'start', 'ownerTag', 'environ', 'argv', 'cmdline', 'commandLine', 'ppid', 'cgroup'].includes(field));
        const result: ResolvedProcessOwnership = { pid: row.pid, start: row.start, owner: selected?.owner ?? null, ownerEnded,
            level: resolveProcessOwnershipLevel({ samePrincipal: nativeConflict ? undefined
                : principal === undefined ? undefined : principal === 'self', ownerEnded, evidence, observationsIncomplete }),
            evidence, chain: prior && selected && !selected.live && equalProcessStart(prior.start, row.start) ? prior.chain : chain,
            ...(selected?.workspacePath ? { workspacePath: selected.workspacePath } : {}) };
        return result;
    });
    // Weak group/port evidence may only borrow a proven member's owner, never another weak claim.
    const provenGroupOwners = new Map<number, HappierProcessRoot | null>();
    for (const item of baseResults) {
        const row = index.byPid.get(item.pid);
        const root = item.owner ? rootsByOwner.get(processOwnerKey(item.owner)) : undefined;
        if (item.level === 'proven' && row?.pgid !== undefined && root && root.owner.kind !== 'container') {
            const previous = provenGroupOwners.get(row.pgid);
            if (!provenGroupOwners.has(row.pgid)) provenGroupOwners.set(row.pgid, root);
            else if (previous && processOwnerKey(previous.owner) !== processOwnerKey(root.owner)) provenGroupOwners.set(row.pgid, null);
        }
    }
    return baseResults.map(item => {
        if (item.owner || item.level === 'unknown'
            || compareProcessPrincipals(index.byPid.get(item.pid)?.principal ?? null, input.daemonPrincipal) !== 'self') return item;
        const row = index.byPid.get(item.pid)!;
        const workspaceCandidates = listening.has(row.pid) && row.cwd ? [...rootsByOwner.values()].flatMap(root => {
            const remainder = root.workspacePath ? getPathRemainderWithinBase(row.cwd!, root.workspacePath) : null;
            return root.owner.kind !== 'container' && remainder !== null
                && row.start.startTimeMs >= (platform === 'linux' ? root.ownerCreatedStartTimeMs ?? Number.POSITIVE_INFINITY : root.ownerCreatedAtMs)
                && (root.endedAtMs === undefined || (platform === 'linux'
                    ? root.ownerCreatedAtMs + row.start.startTimeMs - (root.ownerCreatedStartTimeMs ?? Number.POSITIVE_INFINITY)
                    : row.start.startTimeMs) <= root.endedAtMs)
                ? [{ root, remainder }] : [];
        }).sort((left, right) => left.remainder.length - right.remainder.length) : [];
        const deepest = workspaceCandidates.filter(candidate => candidate.remainder.length === workspaceCandidates[0]?.remainder.length);
        const workspaceOwner = deepest.length === 1 ? deepest[0]?.root : undefined;
        const groupOwner = row.pgid === undefined ? undefined : provenGroupOwners.get(row.pgid);
        const likely = groupOwner ?? workspaceOwner;
        if (!likely && (deepest.length > 1 || groupOwner === null)) return { ...item, level: 'unknown' as const,
            evidence: item.evidence.map(fact => fact.kind === 'group_and_port'
                ? { kind: fact.kind, state: 'not_available' as const, reason: 'required_fields_unreadable' as const } : fact) };
        if (!likely) return item;
        const evidence = item.evidence.map(fact => fact.kind === 'group_and_port'
            ? { kind: fact.kind, state: 'met' as const, reason: 'same_group_port_opened_while_running' as const } : fact);
        return { ...item, owner: likely.owner, ownerEnded: !likely.live, evidence,
            level: resolveProcessOwnershipLevel({ samePrincipal: true, ownerEnded: !likely.live, evidence, observationsIncomplete: false }),
            ...(likely.workspacePath ? { workspacePath: likely.workspacePath } : {}) };
    });
}

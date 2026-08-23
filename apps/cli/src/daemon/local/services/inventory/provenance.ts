import { getPathRemainderWithinBase } from '../../../../session/handoff/paths/sessionHandoffPathNormalization';
import type { LocalServiceProcessOwnership } from './platform/processOwnership';
import type { TerminalProcessRegistry } from './terminalRegistry';

export type LocalServiceProcessFact = Readonly<{
    pid: number;
    ppid?: number;
    processStartTimeMs?: number;
    command: string;
    cwd?: string;
    /**
     * Whether this process is controllable by the daemon's own OS identity, as established by
     * the platform scanner (`platform/processOwnership.ts`). `undefined` means the platform
     * could not establish it, which the scanner treats as unproven, not as another owner.
     */
    processOwnership?: LocalServiceProcessOwnership;
}>;

export const LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH = 4;

export type LocalServiceWorkspaceFact = Readonly<{
    id?: string;
    path: string;
}>;

export type RecoveredProcessLineageFacts = Readonly<{
    pid: number;
    ppid?: number;
    processStartTimeMs?: number;
    lineagePids: readonly number[];
    command: string;
    cwd?: string;
    redacted: true;
}>;

const SECRET_FLAG_PATTERN = /((?:--?|\/)(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)(?:=|\s+))("?[^\s"']+"?)/gi;
const SECRET_ENV_ASSIGNMENT_PATTERN = /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)[A-Za-z0-9_]*=)("[^"]*"|'[^']*'|[^\s]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// Prefix-anchored provider-key families. Anchored on each vendor's documented token
// prefix so a bare positional / flag-value / env-value token is redacted regardless of
// the surrounding flag or env-var name (which may carry no `secret`/`token` keyword).
// Deliberately prefix-anchored, never generic high-entropy matching, to avoid eating
// non-secret args (paths, hashes, base64 blobs). Covers, in addition to the families
// below: Stripe/restricted (`sk`/`pk`/`rk`), GitHub (`ghp`/`github_pat`), GitLab
// (`glpat`), Slack (`xox[baprs]`), AWS access-key ids (`AKIA`/`ASIA`), Google API keys
// (`AIza`), Hugging-Face (`hf_`), and npm (`npm_`).
const PROVIDER_KEY_PATTERN = /\b(?:sk|pk|rk|ghp|github_pat|glpat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/g;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{30,}\b/g;
const PREFIXED_PROVIDER_TOKEN_PATTERN = /\b(?:hf|npm)_[A-Za-z0-9]{16,}\b/g;

export function redactProcessCommand(command: string): string {
    return String(command)
        .replace(SECRET_ENV_ASSIGNMENT_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(SECRET_FLAG_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
        .replace(PROVIDER_KEY_PATTERN, '[REDACTED]')
        .replace(AWS_ACCESS_KEY_ID_PATTERN, '[REDACTED]')
        .replace(GOOGLE_API_KEY_PATTERN, '[REDACTED]')
        .replace(PREFIXED_PROVIDER_TOKEN_PATTERN, '[REDACTED]')
        .slice(0, 1_000);
}

function isPackageManagerRunCommand(command: string): boolean {
    return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?:\s|$)/i.test(command);
}

function isGenericListenerChild(command: string): boolean {
    const lower = command.toLowerCase();
    return /(?:^|\s)(?:node|python|python3|tsx|ts-node|vite|next|nuxt|astro)(?:\s|$|\.|\/)/.test(lower);
}

function commandScore(command: string): number {
    if (isPackageManagerRunCommand(command)) return 100;
    if (/\b(?:vite|next|nuxt|astro|expo|webpack-dev-server|uvicorn|flask|django|rails|cargo|dotnet)\b/i.test(command)) {
        return 80;
    }
    // A generic listener command is still stronger evidence than unrelated
    // ancestors such as shells, agent hosts, or launch supervisors. Known
    // package-manager/dev-server parents keep winning above.
    if (isGenericListenerChild(command)) return 60;
    return 50;
}

export function recoverProcessLineageFacts(input: Readonly<{
    listenerPid: number;
    maxDepth: number;
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
}>): RecoveredProcessLineageFacts {
    const visited = new Set<number>();
    const lineagePids: number[] = [];
    const maxDepth = Math.max(0, Math.trunc(input.maxDepth));
    const listenerProcess = input.processes.get(input.listenerPid);
    let current = listenerProcess;
    let best = current;
    let bestScore = current ? commandScore(current.command) : -1;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
        if (visited.has(current.pid)) break;
        visited.add(current.pid);
        lineagePids.push(current.pid);
        const score = commandScore(current.command);
        if (score > bestScore) {
            best = current;
            bestScore = score;
        }
        current = current.ppid ? input.processes.get(current.ppid) : undefined;
    }
    const fallback = best ?? input.processes.get(input.listenerPid);
    if (!fallback) {
        return {
            pid: input.listenerPid,
            lineagePids: [input.listenerPid],
            command: 'unknown',
            redacted: true,
        };
    }
    return {
        pid: input.listenerPid,
        ...(listenerProcess?.ppid ? { ppid: listenerProcess.ppid } : {}),
        ...(typeof listenerProcess?.processStartTimeMs === 'number'
            ? { processStartTimeMs: listenerProcess.processStartTimeMs }
            : {}),
        lineagePids,
        command: redactProcessCommand(fallback.command),
        ...(fallback.cwd ? { cwd: fallback.cwd } : {}),
        redacted: true,
    };
}

function isPathWithin(parent: string, child: string): boolean {
    // Reuse the canonical Windows-safe containment owner (drive-letter case-fold,
    // trailing-separator trim, mixed-separator normalize, sibling-prefix guard).
    // Do NOT hand-roll a second path normalizer here.
    return getPathRemainderWithinBase(child, parent) !== null;
}

/**
 * True when `candidate` is the workspace root `parent` or nested within it. Shared
 * path-containment owner for workspace-scope filtering (do not hand-roll `~`/path logic).
 */
export function isWorkspacePathWithin(parent: string, candidate: string): boolean {
    return isPathWithin(parent, candidate);
}

export function matchWorkspaceAssociation(input: Readonly<{
    cwd: string | undefined;
    workspaces: readonly LocalServiceWorkspaceFact[];
}>): Readonly<{
    workspace?: Readonly<{
        id?: string;
        path: string;
        association: 'cwd_containment';
    }>;
    workspaceAssociationConfidence: 'high' | 'medium' | 'low';
}> {
    if (!input.cwd) {
        return { workspaceAssociationConfidence: 'low' };
    }
    const matches = input.workspaces
        .filter((workspace) => isPathWithin(workspace.path, input.cwd as string))
        .sort((a, b) => b.path.length - a.path.length);
    const match = matches[0];
    if (!match) {
        return { workspaceAssociationConfidence: 'low' };
    }
    return {
        workspace: {
            ...(match.id ? { id: match.id } : {}),
            path: match.path,
            association: 'cwd_containment',
        },
        workspaceAssociationConfidence: 'high',
    };
}

export type TerminalRegistrationMatch = Readonly<{
    workspace?: Readonly<{
        path: string;
        association: 'process_tree';
    }>;
    workspaceAssociationConfidence: 'high' | 'medium' | 'low';
    session?: Readonly<{ id: string }>;
}>;

/**
 * Deterministic terminal->port match: if the listener pid (or any recovered lineage
 * pid) was spawned by a known daemon terminal, return its workspace (high confidence,
 * `process_tree` association) plus the originating session attribution.
 *
 * This is additive to — and takes precedence over — cwd-containment
 * (`matchWorkspaceAssociation`), which stays the fallback for un-registered listeners.
 */
export function matchTerminalRegistration(input: Readonly<{
    listenerPid: number | undefined;
    lineagePids: readonly number[];
    registry: TerminalProcessRegistry | undefined;
}>): TerminalRegistrationMatch {
    const registry = input.registry;
    if (!registry) {
        return { workspaceAssociationConfidence: 'low' };
    }
    const candidatePids: number[] = [];
    if (typeof input.listenerPid === 'number') {
        candidatePids.push(input.listenerPid);
    }
    for (const pid of input.lineagePids) {
        candidatePids.push(pid);
    }
    for (const pid of candidatePids) {
        const registration = registry.lookupByPid(pid);
        if (registration) {
            return {
                workspace: {
                    path: registration.workspacePath,
                    association: 'process_tree',
                },
                workspaceAssociationConfidence: 'high',
                ...(registration.sessionId ? { session: { id: registration.sessionId } } : {}),
            };
        }
    }
    return { workspaceAssociationConfidence: 'low' };
}

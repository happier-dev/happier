import path from 'node:path';

export type LocalServiceProcessFact = Readonly<{
    pid: number;
    ppid?: number;
    command: string;
    cwd?: string;
}>;

export type LocalServiceWorkspaceFact = Readonly<{
    id?: string;
    path: string;
}>;

export type RecoveredProcessLineageFacts = Readonly<{
    pid: number;
    ppid?: number;
    lineagePids: readonly number[];
    command: string;
    cwd?: string;
    redacted: true;
}>;

const SECRET_FLAG_PATTERN = /((?:--?|\/)(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)(?:=|\s+))("?[^\s"']+"?)/gi;
const SECRET_ENV_ASSIGNMENT_PATTERN = /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:api[-_]?key|auth|bearer|password|passwd|pwd|secret|token)[A-Za-z0-9_]*=)("[^"]*"|'[^']*'|[^\s]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PROVIDER_KEY_PATTERN = /\b(?:sk|pk|rk|ghp|github_pat|glpat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/g;

export function redactProcessCommand(command: string): string {
    return String(command)
        .replace(SECRET_ENV_ASSIGNMENT_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(SECRET_FLAG_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED]`)
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
        .replace(PROVIDER_KEY_PATTERN, '[REDACTED]')
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
    if (isGenericListenerChild(command)) return 20;
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
        if (score >= bestScore) {
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
        lineagePids,
        command: redactProcessCommand(fallback.command),
        ...(fallback.cwd ? { cwd: fallback.cwd } : {}),
        redacted: true,
    };
}

function isPathWithin(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

import type { ScmRemoteRequest } from '@happier-dev/protocol';

type PullArgsResult =
    | { ok: true; args: string[] }
    | { ok: false; error: string };

type RemoteRequestInput = Readonly<Pick<ScmRemoteRequest, 'remote'> & Partial<Pick<ScmRemoteRequest, 'branch'>>>;

function resolvePullDestination(request: RemoteRequestInput): string | null {
    const branch = request.branch?.trim();
    if (!branch) return null;
    if (branch.includes('/')) return branch;
    if (request.remote?.trim()) {
        return `${request.remote.trim()}/${branch}`;
    }
    return branch;
}

export function buildPullArgs(
    request: RemoteRequestInput,
    update: boolean
): PullArgsResult {
    const args = ['pull'];
    if (update) {
        const destination = resolvePullDestination(request);
        if (!destination) {
            return {
                ok: false,
                error: 'Branch is required for sapling pull updates',
            };
        }
        args.push('--update', '--dest', destination);
    }
    if (request.remote) {
        args.push(request.remote);
    }
    return {
        ok: true,
        args,
    };
}

export function buildPushArgs(request: RemoteRequestInput): string[] {
    const args = ['push'];
    if (request.branch) {
        args.push('--to', request.branch);
    }
    if (request.remote) {
        args.push(request.remote);
    }
    return args;
}

import { isAbsolute } from 'node:path';
import { readCurrentBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { ScmHostingProviderKindSchema } from '@happier-dev/plugin-sdk/scm/hosting';
import { readCurrentHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';
import { GIT_INSTALLABLE_DEP_ID } from '../installables/gitInstallable.js';
import { runScmCommand, type ScmExecResult } from '../runtime.js';
import { resolveDefaultPullRequestStatusProjectionRegistry } from './pullRequestStatusProjection.js';

function normalizeRemoteUrl(raw: string): string | null {
    try {
        const parsed = new URL(raw.trim());
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');
        return parsed.toString();
    } catch {
        return null;
    }
}

/** Git's own rule: a URL with a scheme, or `host:path` (a colon before any slash), names another host; anything
 * else (absolute, relative, a drive path on Windows) is a repository on this Machine's disk. */
function isLocalRepositoryUrl(url: string): boolean {
    if (url.startsWith('file://')) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
    const colon = url.indexOf(':');
    const slash = url.search(/[\\/]/);
    return colon < 0 || (slash >= 0 && slash < colon) || isAbsolute(url);
}

const authRequired = (): ScmExecResult => ({ success: false, exitCode: 128, stdout: '',
    stderr: 'fatal: Authentication failed: connect a Git account with repository access and use HTTPS.' });

async function resolveRemoteAuthorization(remote: string, url: string): Promise<string | null> {
    const registry = await resolveDefaultPullRequestStatusProjectionRegistry();
    const runtimeServices = readCurrentHostingProviderRuntimeServices();
    const detected = registry.detectRemote({ remoteName: remote, remoteUrl: url });
    if (detected.kind !== 'resolved') return null;
    const kind = ScmHostingProviderKindSchema.safeParse(detected.provider.kind);
    if (!kind.success) return null;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const capability = registry.getRepositoryClone(detected.providerId);
    const authentication = await capability?.resolveCloneAuthentication?.({ provider: {
        id: detected.provider.id, kind: kind.data, displayName: detected.provider.displayName, baseUrl: detected.provider.baseUrl,
        ...(detected.provider.nameWithOwner ? { nameWithOwner: detected.provider.nameWithOwner } : {}),
        urlSafety: { ...detected.provider.urlSafety, allowedSchemes: [...(detected.provider.urlSafety?.allowedSchemes ?? ['https:'])] },
    }, ...(runtimeServices ? { runtimeServices } : {}) });
    return authentication?.kind === 'available' ? authentication.authorizationHeader : null;
}

/**
 * Another person's request on this Machine (`requesterAccountOnly`): the remote's own configured URL,
 * read before the executing user's insteadOf rules, is the one repository their connected account
 * serves. The host transport keeps the credential; Git sees a loopback URL with its helpers reset.
 * A repository on this Machine's disk needs no credential and runs as it always does.
 */
async function runGitRemoteWithRequesterAccount(input: Readonly<{
    remote: string | undefined; direction: 'fetch' | 'push'; command: Parameters<typeof runScmCommand>[0];
}>, transport: NonNullable<NonNullable<ReturnType<typeof readCurrentBackendRuntimeServices>>['repositoryTransport']>): Promise<ScmExecResult> {
    const config = (key: string) => runScmCommand({ ...input.command, args: ['config', '--get-all', key] });
    let remote = input.remote;
    if (!remote) {
        const head = await runScmCommand({ ...input.command, args: ['symbolic-ref', '--short', '-q', 'HEAD'] });
        const configured = head.success && head.stdout.trim() ? await config(`branch.${head.stdout.trim()}.remote`) : undefined;
        remote = configured?.success && configured.stdout.trim() ? configured.stdout.trim() : 'origin';
    }
    let urls = input.direction === 'push' ? await config(`remote.${remote}.pushurl`) : undefined;
    if (!urls?.success || !urls.stdout.trim()) urls = await config(`remote.${remote}.url`);
    const configured = urls.success ? urls.stdout.split(/\r?\n/).map(url => url.trim()).filter(Boolean) : [];
    if (configured.length === 1 && isLocalRepositoryUrl(configured[0])) return runScmCommand(input.command);
    if (configured.length !== 1 || !configured[0].startsWith('https://')) return authRequired();
    const authorizationHeader = await resolveRemoteAuthorization(remote, configured[0]);
    if (!authorizationHeader) return authRequired();
    return transport.run({ repositories: [{ url: configured[0], authorizationHeader }],
        command: { ...input.command, args: input.command.args, command: 'git', installableKey: GIT_INSTALLABLE_DEP_ID } });
}

/** Every Git network command of the backend: the connected account where the host requires one. */
export async function runGitRemoteCommand(input: Readonly<{
    remote: string | undefined; direction: 'fetch' | 'push'; command: Parameters<typeof runScmCommand>[0];
}>): Promise<ScmExecResult> {
    const transport = readCurrentBackendRuntimeServices()?.repositoryTransport;
    if (transport?.requesterAccountOnly) return runGitRemoteWithRequesterAccount(input, transport);
    if (input.direction === 'push') return runGitPushWithConnectedAccount(input);
    return runScmCommand(input.command);
}

/** The target has no account credential; both push entry points use the host's private transport. */
export async function runGitPushWithConnectedAccount(input: Readonly<{
    remote: string | undefined;
    command: Parameters<typeof runScmCommand>[0];
}>): Promise<ScmExecResult> {
    const transport = readCurrentBackendRuntimeServices()?.repositoryTransport;
    if (transport?.requesterAccountOnly) return runGitRemoteWithRequesterAccount({ ...input, direction: 'push' }, transport);
    if (!transport?.requiresConnectedAccount) return runScmCommand(input.command);
    const destinationMismatch = (): ScmExecResult => ({ success: false, exitCode: 128, stdout: '',
        stderr: 'fatal: Git push destination differs from the host-recorded Project files source.',
        errorCode: SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED });
    if (!input.remote) return authRequired();
    const recordedSource = readCurrentBackendRuntimeServices()?.projectFilesSource;
    if (!recordedSource) return authRequired();
    const repositoryUrl = `${recordedSource.provider.baseUrl.replace(/\/+$/, '')}/${recordedSource.repository.nameWithOwner}`;
    const sourceUrl = recordedSource.repository.cloneUrl ?? repositoryUrl;
    const normalizedSourceUrl = normalizeRemoteUrl(sourceUrl);
    if (!normalizedSourceUrl) return authRequired();
    // Read the effective push destination after Git's insteadOf/pushurl rules. A guest can edit
    // this config, so every destination must match the immutable host-recorded recipe source.
    const configured = await runScmCommand({ ...input.command, args: ['remote', 'get-url', '--push', '--all', input.remote] });
    if (!configured.success) return configured;
    const destinations = configured.stdout.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
    if (destinations.length !== 1) return destinationMismatch();
    const destination = normalizeRemoteUrl(destinations[0]);
    // A saved GitHub Source can carry the repository address, while a clone uses GitHub's .git endpoint.
    const cloneEndpoint = recordedSource.provider.kind === 'github' && recordedSource.protocol === 'https'
        && normalizedSourceUrl === repositoryUrl && repositoryUrl.startsWith('https://') ? `${repositoryUrl}.git` : undefined;
    const pushUrl = destination === normalizedSourceUrl ? sourceUrl : destination === cloneEndpoint ? cloneEndpoint : undefined;
    if (!pushUrl) return destinationMismatch();
    const authorizationHeader = await resolveRemoteAuthorization(input.remote, pushUrl);
    if (!authorizationHeader) return authRequired();
    // Preserve the remote name so Git updates refs/remotes/<name>; the host transport supplies
    // the credential and rewrites only the matching source URL for the admitted command.
    return transport.run({ repositories: [{ url: pushUrl, authorizationHeader }],
        command: { ...input.command, args: input.command.args, command: 'git', installableKey: GIT_INSTALLABLE_DEP_ID } });
}

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

/** The target has no account credential; both push entry points use the host's private transport. */
export async function runGitPushWithConnectedAccount(input: Readonly<{
    remote: string | undefined;
    command: Parameters<typeof runScmCommand>[0];
}>): Promise<ScmExecResult> {
    const transport = readCurrentBackendRuntimeServices()?.repositoryTransport;
    if (!transport?.requiresConnectedAccount) return runScmCommand(input.command);
    const authRequired = (): ScmExecResult => ({ success: false, exitCode: 128, stdout: '',
        stderr: 'fatal: Authentication failed: connect a Git account with repository access and use HTTPS.' });
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
    const registry = await resolveDefaultPullRequestStatusProjectionRegistry();
    const runtimeServices = readCurrentHostingProviderRuntimeServices();
    const repositories: { url: string; authorizationHeader: string }[] = [];
    const detected = registry.detectRemote({ remoteName: input.remote, remoteUrl: pushUrl });
    if (detected.kind !== 'resolved') return authRequired();
    const kind = ScmHostingProviderKindSchema.safeParse(detected.provider.kind);
    if (!kind.success) return authRequired();
    let parsed: URL;
    try { parsed = new URL(pushUrl); } catch { return authRequired(); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return authRequired();
    const capability = registry.getRepositoryClone(detected.providerId);
    const authentication = await capability?.resolveCloneAuthentication?.({ provider: {
        id: detected.provider.id, kind: kind.data, displayName: detected.provider.displayName, baseUrl: detected.provider.baseUrl,
        ...(detected.provider.nameWithOwner ? { nameWithOwner: detected.provider.nameWithOwner } : {}),
        urlSafety: { ...detected.provider.urlSafety, allowedSchemes: [...(detected.provider.urlSafety?.allowedSchemes ?? ['https:'])] },
    }, ...(runtimeServices ? { runtimeServices } : {}) });
    if (authentication?.kind !== 'available') return authRequired();
    repositories.push({ url: pushUrl, authorizationHeader: authentication.authorizationHeader });
    // Preserve the remote name so Git updates refs/remotes/<name>; the host transport supplies
    // the credential and rewrites only the matching source URL for the admitted command.
    return transport.run({ repositories,
        command: { ...input.command, args: input.command.args, command: 'git', installableKey: GIT_INSTALLABLE_DEP_ID } });
}

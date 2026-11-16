import { readCurrentBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { ScmHostingProviderKindSchema } from '@happier-dev/plugin-sdk/scm/hosting';
import { readCurrentHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';
import { GIT_INSTALLABLE_DEP_ID } from '../installables/gitInstallable.js';
import { runScmCommand, type ScmExecResult } from '../runtime.js';
import { resolveDefaultPullRequestStatusProjectionRegistry } from './pullRequestStatusProjection.js';

/** The target has no account credential; both push entry points use the host's private transport. */
export async function runGitPushWithConnectedAccount(input: Readonly<{
    remote: string | undefined;
    command: Parameters<typeof runScmCommand>[0];
}>): Promise<ScmExecResult> {
    const transport = readCurrentBackendRuntimeServices()?.repositoryTransport;
    if (!transport?.requiresConnectedAccount) return runScmCommand(input.command);
    const authRequired = (): ScmExecResult => ({ success: false, exitCode: 128, stdout: '',
        stderr: 'fatal: Authentication failed: connect a Git account with repository access and use HTTPS.' });
    if (!input.remote) return authRequired();
    // Git owns pushurl multiplicity and insteadOf expansion, including distinct fetch/push URLs.
    const configured = await runScmCommand({ ...input.command, args: ['remote', 'get-url', '--push', '--all', input.remote] });
    if (!configured.success) return configured;
    const urls = configured.stdout.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
    if (!urls.length) return authRequired();
    const registry = await resolveDefaultPullRequestStatusProjectionRegistry();
    const runtimeServices = readCurrentHostingProviderRuntimeServices();
    const repositories: { url: string; authorizationHeader: string }[] = [];
    for (const url of urls) {
        const detected = registry.detectRemote({ remoteName: input.remote, remoteUrl: url });
        if (detected.kind !== 'resolved') return authRequired();
        const kind = ScmHostingProviderKindSchema.safeParse(detected.provider.kind);
        if (!kind.success) return authRequired();
        let parsed: URL;
        try { parsed = new URL(url); } catch { return authRequired(); }
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return authRequired();
        const capability = registry.getRepositoryClone(detected.providerId);
        const authentication = await capability?.resolveCloneAuthentication?.({ provider: {
            id: detected.provider.id, kind: kind.data, displayName: detected.provider.displayName, baseUrl: detected.provider.baseUrl,
            ...(detected.provider.nameWithOwner ? { nameWithOwner: detected.provider.nameWithOwner } : {}),
            urlSafety: { ...detected.provider.urlSafety, allowedSchemes: [...(detected.provider.urlSafety?.allowedSchemes ?? ['https:'])] },
        }, ...(runtimeServices ? { runtimeServices } : {}) });
        if (authentication?.kind !== 'available') return authRequired();
        repositories.push({ url, authorizationHeader: authentication.authorizationHeader });
    }
    return transport.run({ repositories,
        command: { ...input.command, command: 'git', installableKey: GIT_INSTALLABLE_DEP_ID } });
}

import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import type { HostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { createGitBackend, createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';
import type { ScmCommandRunner } from '@/scm/runtime';

/** Real plugin SCM registration, usable by source-runtime and Vitest boundary fixtures. */
export function createDeploymentGitRegistry(hostingProviderRuntimeServices?: HostingProviderRuntimeServices, scmCommandRunner?: ScmCommandRunner) {
    const capabilities = createGitBackend().declaredCapabilities!;
    return createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git' }, qualifiedId: 'scm-git/git',
        executableDefinition: { repoModes: ['.git'], capabilities, commands: [{ installableKey: 'git-cli', command: 'git' }] },
        registration: createGitScmBackendRuntimeRegistration(),
        ...(hostingProviderRuntimeServices ? { hostingProviderRuntimeServices } : {}),
        ...(scmCommandRunner ? { scmCommandRunner } : {}),
    })]);
}

import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import type { HostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';
import { GIT_SCM_BACKEND_CONTRIBUTION, PLUGIN_MANIFEST } from '../../../../../../packages/plugins/scm-git/src/manifest';
import type { ScmCommandRunner } from '@/scm/runtime';

/** Real plugin SCM registration, usable by source-runtime and Vitest boundary fixtures. */
export function createDeploymentGitRegistry(hostingProviderRuntimeServices?: HostingProviderRuntimeServices, scmCommandRunner?: ScmCommandRunner) {
    const registration = createGitScmBackendRuntimeRegistration();
    return createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: GIT_SCM_BACKEND_CONTRIBUTION,
        qualifiedId: `${PLUGIN_MANIFEST.id}/${registration.id}`, executableDefinition: registration.runtime!, registration,
        ...(hostingProviderRuntimeServices ? { hostingProviderRuntimeServices } : {}),
        ...(scmCommandRunner ? { scmCommandRunner } : {}),
    })]);
}

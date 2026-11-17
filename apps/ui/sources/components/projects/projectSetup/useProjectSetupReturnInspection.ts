import type { PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import type { ProjectSetupReadinessV1 } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { useProjectDefinitionInspection } from './useProjectDefinitionInspection';

/** Current checkout facts on return; authoring Session completion supplies no setup evidence. */
export function useProjectSetupReturnInspection(origin: PluginUiNewSessionSeedOriginV1 | null): Readonly<{
    summary: string | null;
    setupReadiness: ProjectSetupReadinessV1 | null;
}> {
    const setupOrigin = origin?.kind === 'project' && origin.page === 'scripts' && origin.purpose !== 'session' ? origin : null;
    const { binding } = useServerCredentialAccountScopeBinding(setupOrigin?.workspace.serverId);
    const { read, effectiveDefinition } = useProjectDefinitionInspection(
        setupOrigin?.workspace ?? null,
        binding?.accountId === setupOrigin?.accountId ? binding : null,
        { kind: 'setup' },
    );
    if (!read || 'error' in read) return { summary: null, setupReadiness: null };
    const setupReadiness = read.value.setupReadiness ?? null;
    const manifest = effectiveDefinition?.kind === 'available' ? effectiveDefinition.value.effectiveManifest : null;
    if (!manifest) return { summary: null, setupReadiness };
    const scripts = Object.keys(manifest.scripts ?? {}).length;
    const services = Object.keys(manifest.services ?? {}).length;
    return { summary: [
        t('projects.authoring.scriptsCount', { count: scripts }),
        ...(services > 0 ? [t('projects.authoring.servicesCount', { count: services })] : []),
    ].join(' · '), setupReadiness };
}

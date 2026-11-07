import * as React from 'react';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSavedSecretReferenceResolver } from '@/components/secrets/useSavedSecretCatalog';
import { sharedSecretStatusLabel } from '@/components/secrets/savedSecretRowCopy';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

/** Overview and Variables consume the catalog's same metadata-only withdrawal result. */
export function DeploymentSecretBindingsNotice(props: Readonly<{
    bindings: readonly EnvironmentSecretBindingV1[];
    scope: AccountSettingsScope | null;
}>) {
    const router = useRouter();
    const reader = useSavedSecretReferenceResolver({ scope: props.scope, includeMaterial: false });
    const seen = new Set<string>();
    return <>{props.bindings.map(binding => {
        if (binding.purpose !== 'variable' || binding.source.kind !== 'secret' || !props.scope) return null;
        const ref = binding.source.ref;
        const key = JSON.stringify([binding.name, ref]);
        if (seen.has(key)) return null;
        seen.add(key);
        const resolution = reader.resolve(ref);
        const status = resolution.displayStatus ?? resolution.status;
        if (status === 'ready') return null;
        const id = `project-deployments.environment.variable.${binding.name}.unavailable`;
        return <SurfaceStateCard key={key} testID={id} size="line" kind="warning"
            title={binding.name} reason={sharedSecretStatusLabel(status)} diagnosticCode={status}
            note={t('projects.deployments.factSecretsValue')}
            action={{ label: t('settings.secrets'), testID: `${id}.repair`,
                onPress: () => router.push({ pathname: SETTINGS_ROUTES.secrets, params: { secret: ref } }) }} />;
    })}</>;
}

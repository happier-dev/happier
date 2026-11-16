import type { PluginDiagnosticRemediationV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';

import { t } from '@/text';

/** The one copy for the repair a plugin diagnostic carries (`PluginDiagnosticRemediationV1`). */
export function resolvePluginDiagnosticRemediationMessage(
  remediation: PluginDiagnosticRemediationV1 | undefined,
): string | null {
  if (!remediation) return null;

  switch (remediation.kind) {
    case 'retry':
      return t('externalSessions.settingsIntegrationRemediationRetry');
    case 'openSettings':
      return t('externalSessions.settingsIntegrationRemediationOpenSettings', {
        path: remediation.path,
      });
    case 'selectAccount':
      return t('externalSessions.settingsIntegrationRemediationSelectAccount', {
        service: `${remediation.service.pluginId}/${remediation.service.localId}`,
      });
    case 'installDependency':
      return t(
        'externalSessions.settingsIntegrationRemediationInstallDependency',
        {
          dependency: remediation.dependencyId,
        },
      );
    case 'openUrl':
      return t('externalSessions.settingsIntegrationRemediationOpenUrl', {
        url: remediation.url,
      });
  }
}

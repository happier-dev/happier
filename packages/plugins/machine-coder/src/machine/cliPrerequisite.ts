import { projectUnavailableManagedDependency } from '@happier-dev/plugin-sdk/managed-services';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CONTRIBUTION, DEPENDENCY_ID } from './schemas.js';

export const CODER_CLI_INSTALL_ACTION = 'cli-install-docs';
export const CODER_CLI_INSTALL_DOCS_URL = 'https://coder.com/docs/install/cli';

/** The host dependency owner decides readiness; this projects its refusal. */
export class CoderCliUnavailable extends PluginError {
  readonly checkResult: MachineProvisionerCheckResultV1;
  constructor(endpoint: string) {
    const message = 'Install the CLI matching your Coder deployment on the Happier controller and make coder available on its PATH. See '
      + CODER_CLI_INSTALL_DOCS_URL + ' or your deployment installer at ' + endpoint + '/install.sh.';
    super({ code: 'coder_cli_unavailable', message, remediation: { kind: 'openUrl', url: CODER_CLI_INSTALL_DOCS_URL } });
    this.checkResult = { available: false, code: this.code, prerequisites: [projectUnavailableManagedDependency({ pluginId: CONTRIBUTION.pluginId, localId: DEPENDENCY_ID }, {
      reason: message, repairAction: { action: { pluginId: CONTRIBUTION.pluginId, localId: CODER_CLI_INSTALL_ACTION }, input: {} },
    })] };
  }
}

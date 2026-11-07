import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { DeploymentIdentifierV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

/** Presentation only: the installed binary retains transport, auth and waiting. */
export function renderDeploymentGithubActionsStep(input: Readonly<{
  serverIdentityId: string; serverApiUrl: string; environmentId: string;
}>): string {
  const identity = {
    serverId: DeploymentIdentifierV1Schema.parse(input.serverIdentityId),
    environmentId: DeploymentIdentifierV1Schema.parse(input.environmentId),
  };
  // Authored identifiers are data, even when they contain GitHub expression
  // syntax. JSON unicode escapes survive both YAML and shell parsing.
  const identityJson = JSON.stringify(identity).replaceAll('$', '\\u0024');
  const request = `${identityJson.slice(0, -1)},"sha":"\${{ github.sha }}","requestKey":"\${{ github.run_id }}-\${{ github.run_attempt }}"}`;
  // GitHub evaluates env values after YAML parsing. A string-literal expression
  // preserves the exact URL without evaluating expression-like authored bytes.
  const serverUrlLiteral = `\${{ '${input.serverApiUrl.replaceAll("'", "''")}' }}`;
  // JSON is also YAML. Emit a copyable steps item without another YAML writer.
  return JSON.stringify([{
    name: 'Deploy with Happier',
    shell: 'bash',
    env: { HAPPIER_TOKEN: '${{ secrets.HAPPIER_TOKEN }}', HAPPIER_SERVER_URL: serverUrlLiteral },
    run: `happier actions invoke deployments.deploy --input-json ${safeBashSingleQuote(request)} --wait --json`,
  }], null, 2);
}

import { renderHelpPage } from '@happier-dev/cli-common/output';
import { BUNDLED_ACTION_CLI_HELP } from '@/plugins/projection/registry/sources/generatedBundledActionCliHelp';
import { ACTION_CLI_JSON_OUTPUT_FLAG } from '@/cli/actions/flags';

export function showHelp(): void {
  const discoveryCommands = BUNDLED_ACTION_CLI_HELP.filter((command) => (
    command.path[0] === 'actions' && command.visibility !== 'hidden'
  ));
  console.log(renderHelpPage({
    title: 'happier actions',
    subtitle: 'Discover and invoke built-in and contributed Actions',
    usage: [
      ...discoveryCommands.map((command) => ({
        label: command.usageLine,
        description: command.title,
      })),
      { label: 'happier actions invoke <action-id> [options]', description: 'Invoke an Action' },
      { label: 'happier actions get deployments.deploy --github-actions --environment <id> --server-id <id>',
        description: 'Print a finite GitHub Actions step for an installed Happier binary' },
    ],
    sections: [
      { title: 'Options:', rows: [
        { label: '--server-id <id>', description: 'Use credentials and endpoint for an exact saved Home' },
        { label: '--machine-id <id>', description: 'Target an exact machine' },
        { label: '--project-directory <path>', description: 'Bind a Machine-local Workflow project directory' },
        { label: '--workspace-ref-id <id>', description: 'Bind the saved Workspace reference for the project' },
        { label: '--source-path <path>', description: 'Local prepared filesystem upload source (never sent as Action input)' },
        { label: '--destination-path <path>', description: 'Local prepared filesystem download destination (never sent as Action input)' },
        { label: '--<field> <value>', description: 'Ordinary Action input field for invoke' },
        { label: '--<field>-json <json>', description: 'One nested Action input field for invoke' },
        { label: '--input-json <json>', description: 'Whole Action input for invoke' },
        { label: '--request-id <id>', description: 'Request correlation identifier; do not reuse after a daemon restart to mean "the same request"' },
        { label: '--limit <n>', description: 'Bound search results' },
        { label: ACTION_CLI_JSON_OUTPUT_FLAG, description: 'Stable JSON envelope' },
      ] },
    ],
    notes: ['Use a query and --limit for a concise catalog search.', 'Contributed IDs use <pluginId>/actions/<localId>.', 'Authentication may come from happier auth login or HAPPIER_TOKEN.',
      'account.apiTokens.create and account.apiTokens.update require present-user approval; API tokens cannot invoke them.',
      'Token creation returns its secret once to the waiting caller. Use auth api-tokens create --encryption for trusted-device encryption preparation.'],
  }));
}


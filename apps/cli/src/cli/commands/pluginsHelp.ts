import { cmd, renderHelpPage } from '@happier-dev/cli-common/output';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import { pluginSettingsHelpRows } from './pluginSettingsHelp';
import { PluginScaffoldTemplateSchema } from '@happier-dev/protocol/actions/actionSpecs';

export function renderPluginHelp(scaffoldUiModes: readonly string[]): string {
  const invoker = resolveInvokerName() ?? 'happier';
  const pluginCommand = `${invoker} plugins`;
  return renderHelpPage({
    title: pluginCommand,
    subtitle: 'Plugin discovery, local authoring, and machine-local installs',
    usage: [
      { label: `${pluginCommand} list [--json]`, description: 'List installed plugins and daemon-owned pending changes' },
      { label: `${pluginCommand} show <pluginId> [--json]`, description: 'Show one installed plugin in detail' },
      { label: `${pluginCommand} actions <pluginId> [--json]`, description: 'List invocable actions and tools declared by one installed plugin' },
      { label: `${pluginCommand} install <path|archive|package> [--kind path|archive|npm] [--selector <version>] [--integrity <sha256-SRI>] [--dev] [--dry-run] [--json]`, description: 'Install through the active daemon; an explicit local path is the code-trust action' },
      { label: `${pluginCommand} update <pluginId> [--json]`, description: 'Apply a compatible newer release to one installed plugin through its daemon-owned update channel' },
      { label: `${pluginCommand} rollback <pluginId> [--json]`, description: 'Restore the retained prior plugin version through the active daemon' },
      { label: `${pluginCommand} enable|disable <pluginId> [--json]`, description: 'Change plugin admission through the active daemon' },
      { label: `${pluginCommand} uninstall <pluginId> [--delete-data --yes] [--json]`, description: 'Remove a local installed plugin; preserve its data unless --delete-data --yes is supplied' },
      { label: `${pluginCommand} create <name> [--id <plugin.id>] [--name <display name>] [--template ${PluginScaffoldTemplateSchema.options.join('|')}] [--themes-file <export.json>]… [--ui ${scaffoldUiModes.join('|')}] [--json]`, description: 'Create a plugin project; themes accepts exported theme files and creates a data-only manifest' },
      { label: `${pluginCommand} dev [path] [--sdk-registry <origin>] [--json]`, description: 'Register a trusted source with the daemon and show its canonical development status' },
      { label: `${pluginCommand} dev unregister <path> [--json]`, description: 'Stop observing an exact explicit source and forget its remembered registration' },
      { label: `${pluginCommand} status [--json]`, description: 'Show daemon-owned development roots, phases, current occurrences, and diagnostics' },
      { label: `${pluginCommand} dev install <path> [--sdk-registry <origin>] [--json]`, description: 'Repair or refresh a stale or wiped author root; the watch loop already materializes it' },
      { label: `${pluginCommand} dev typecheck|build|test <path> [--json]`, description: 'Run one managed focused development check' },
      { label: `${pluginCommand} test [path] [--packed] [--with-plugin <root-or-archive>]… [--sdk-registry <origin>] [--json]`, description: 'Run unit tests or pack, install, and exercise the plugin through a disposable daemon' },
      { label: `${pluginCommand} pack <path> [--out <archive.tgz>] [--sdk-registry <origin>] [--json]`, description: 'Validate and package a local plugin into an installable archive' },
      { label: `${pluginCommand} doctor [path] [--json]`, description: 'Evaluate and diagnose a code-defined plugin author module' },
      { label: `${pluginCommand} doctor --installed [<pluginId>] [--json]`, description: 'Inspect installed immutable plugin generations for missing, escaped, non-regular, drifted, or unloadable files' },
      { label: `${pluginCommand} reload [developmentPluginId] [--json]`, description: 'Reapply the development source registered for this directory, or one explicit plugin id' },
      { label: `${pluginCommand} change status <pendingChangeId> [--json]`, description: 'Inspect a daemon-lifetime plugin change; install decisions are ordinary Inbox approvals' },
      { label: `${pluginCommand} logs <pluginId> [--machine <id>] [--occurrence <id>] [--correlation <id>] [--cursor <byteOffset>] [--limit <1-500>] [--follow] [--json]`, description: 'Read canonical structured logs from one exact current daemon' },
      ...pluginSettingsHelpRows(pluginCommand),
      { label: `${pluginCommand} registry add <origin> [--id <id>] [--name <name>] [--scope <@scope>] [--default] [--allow-private-network] [--json]`, description: 'Add a private npm registry profile' },
      { label: `${pluginCommand} registry login <profileId> [--json]`, description: 'Store a registry token through a hidden prompt' },
      { label: `${pluginCommand} registry test|logout|remove <profileId> [--json]`, description: 'Test or change one private registry profile' },
      { label: `${pluginCommand} registry list [--json]`, description: 'List private registry profiles and paused sources' },
      { label: `${pluginCommand} marketplace install [<sourceRef>] <pluginId> [--package <npmPackage>] [--json]`, description: 'Install and trust one exact listing; Community npm requires the package shown by marketplace list' }
    ],
    notes: [
      `Browse and manage Account registries with ${invoker} registries; marketplace list/show/source aliases use those Actions.`,
      'Plugins are machine-local, descriptor-backed plugins.',
      'Current install support covers local directories, reviewed npm packages, local/remote archives, and exact curated or community npm marketplace listings.',
      `Live authoring is local-path based: create a plugin, then run ${pluginCommand} dev from its directory.`,
      'Packed real-host testing uses a disposable authenticated daemon home and does not read or copy user credentials or installed-plugin state.',
      'Direct npm installation is staged behind the install-and-trust flow; private registry profiles are managed with the registry commands.',
      'Marketplace Install and trust rechecks exact version, integrity, manifest, source, and review facts; community code remains unreviewed until its staged Install & Trust decision.',
      `Use ${cmd(`${invoker} agents list`)} to see plugin-provided agent CLI surfaces after install.`,
    ],
  });
}


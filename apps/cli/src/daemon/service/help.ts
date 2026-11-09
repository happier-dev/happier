import { writeJsonStdout } from '@/cli/output/jsonEnvelope';

export async function printDaemonServiceHelp(json: boolean): Promise<void> {
      if (json) {
        await writeJsonStdout({
          ok: true,
          commands: ['list', 'paths', 'install', 'uninstall', 'repair', 'start', 'stop', 'restart', 'status', 'logs', 'tail'],
          flags: ['--json', '--dry-run', '--yes', '--takeover', '--keep-disabled', '--autostart=at-login|on-demand', '--replace-existing=ring|all', '--ring', '--instance', '--all', '--install-root', '--desktop-bundle-id', '--preserve-desktop-ownership'],
        });
        return;
    }
    process.stdout.write(
      [
        'happier service',
        '',
        'Usage:',
        '  happier service list [--json]',
        '  happier service paths [--json]',
        '  happier service status [--json]',
        '  happier service install [--local-relay] [--autostart at-login|on-demand] [--dry-run] [--yes] [--takeover] [--keep-disabled] [--replace-existing=ring|all] [--json]',
        '  happier service uninstall [--ring <stable|preview|dev>] [--instance <id>] [--all [--install-root <path>]] [--yes] [--dry-run] [--json]',
        '  happier service repair [--yes] [--json] (legacy alias for `happier doctor repair`)',
        '  happier service start|stop|restart [--dry-run] [--takeover] [--json]',
        '  happier service logs [--json]',
        '  happier service tail',
        '',
        'Pinned services:',
        '  happier --server <profile-id> service install --instance <service-id> [--autostart <at-login|on-demand>]',
        '  --instance names the service; --server selects its relay and must precede service.',
        '  Use the same --server and --instance when inspecting or controlling that service.',
        '',
        'Compatibility aliases:',
        '  happier daemon service ...',
        '',
      ].join('\n'),
    );
    return;
  }


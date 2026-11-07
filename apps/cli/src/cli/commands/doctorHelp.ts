import { renderHelpPage } from '@happier-dev/cli-common/output';

export function printDoctorHelp(): void {
  console.log(renderHelpPage({
    title: 'happier doctor',
    subtitle: 'System diagnostics and repair',
    usage: [
      { label: 'happier doctor [--json]', description: 'Inspect CLI and daemon health' },
      { label: 'happier doctor --json --include-daemon-log', description: 'Read local daemon facts and its redacted log tail without a running daemon' },
      { label: 'happier doctor repair [options]', description: 'Plan or apply supported repairs' },
      { label: 'happier doctor clean', description: 'Stop stale daemons and review confirmed left-behind processes' },
    ],
  }));
}


import type { LocalRelayEntry } from '@/diagnostics/doctorRepair';

/** Keep guided updates and their printed commands bound to the same installed relay. */
export function localRelayUpdateArgs(entry: Pick<LocalRelayEntry, 'releaseChannel' | 'mode'>): string[] {
  return ['relay', 'host', 'install', '--channel', entry.releaseChannel, '--mode', entry.mode, '--preserve-active-server', '--yes'];
}

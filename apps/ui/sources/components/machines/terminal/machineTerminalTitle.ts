import { t } from '@/text';

export function describeMachineTerminalTitle(machineName: string): string {
    return t('machineDetailPage.terminalSheetTitle', { machine: machineName });
}

export function describeMachineTerminalLabel(
    terminal: Readonly<{ terminalKey: string; label: string }>,
    machineName: string,
): string {
    // Guard observations and retained receipts can carry the terminal key as their label.
    return terminal.label === terminal.terminalKey ? describeMachineTerminalTitle(machineName) : terminal.label;
}

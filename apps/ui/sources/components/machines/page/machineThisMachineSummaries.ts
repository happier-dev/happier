import type { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { t } from '@/text';
import { COMPUTER_PROVIDER_DISPLAY_NAMES } from '@/sync/domains/computer/computerProviderSettings';
import type { ComputerUseSettingsV1 } from '@happier-dev/protocol/computer/v1';

/** "Claude and Codex are ready": the agents the last inventory read found ready, from what the app holds. */
export function describeMachineAgentsReady(titles: readonly string[]): string | null {
    if (titles.length === 0) return null;
    if (titles.length === 1) return t('machineDetailPage.summaries.agentReady', { agent: titles[0]! });
    if (titles.length === 2) return t('machineDetailPage.summaries.agentsReadyPair', { first: titles[0]!, second: titles[1]! });
    return t('machineDetailPage.summaries.agentsReadyCount', { count: titles.length });
}

/** Sharing's row says who it is shared with from what the machine record holds: a machine shared with you names its owner. */
export function describeMachineSharingSummary(machine: Readonly<{ isShared?: boolean; access?: Readonly<{ custodian: Readonly<{ displayName?: string | null }> }> | null }>): string | undefined {
    if (machine.isShared) {
        const owner = machine.access?.custodian.displayName?.trim();
        return owner ? t('machineDetailPage.summaries.sharedByOwner', { owner }) : t('machineDetailPage.summaries.sharedWithYou');
    }
    return undefined;
}

/** "Checked <time>" from the persisted last Doctor snapshot; a machine never checked has no summary. */
export function describeMachineDoctorSummary(snapshot: Readonly<{ cachedAt: number }> | null): string | undefined {
    if (!snapshot) return undefined;
    return t('machineDetailPage.summaries.doctorChecked', { time: new Date(snapshot.cachedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) });
}

/** The terminal multiplexer new sessions on this machine open in, by its own name. */
export function describeMachineTerminalHost(host: ReturnType<typeof resolveTerminalHost>): string {
    if (host === 'tmux') return 'tmux';
    if (host === 'zellij') return 'Zellij';
    if (host === 'herdr') return 'Herdr';
    return t('machineDetailPage.summaries.terminalDirect');
}

/** Computer control's row names the providers agents may use, the default first ("Cua", "Cua and Agent Desktop"). */
export function describeMachineComputerUse(settings: ComputerUseSettingsV1): string {
    const names = [settings.defaultProvider, ...settings.enabledProviders.filter((provider) => provider !== settings.defaultProvider)]
        .map((provider) => COMPUTER_PROVIDER_DISPLAY_NAMES[provider]);
    return names.length === 2 ? t('computerUse.providers.summaryPair', { first: names[0]!, second: names[1]! }) : names[0]!;
}

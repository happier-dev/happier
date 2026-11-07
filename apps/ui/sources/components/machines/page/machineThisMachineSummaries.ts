import type { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import type { InstallablesSummary } from '@/capabilities/installablesSummary';
import { t } from '@/text';
import type { ComputerUseSettingsV1 } from '@happier-dev/protocol/computer/v1';
import { COMPUTER_PROVIDER_DISPLAY_NAMES } from '@/sync/domains/computer/computerProviderSettings';

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

/** "3 installed · 2 ready" from the inventory the Tools page already read; anything not yet observed leaves the row's title alone. */
export function describeMachineToolsSummary(summary: InstallablesSummary): string | undefined {
    if (summary.status !== 'ready') return undefined;
    return t('machineDetailPage.summaries.toolsInstalledReady', { installed: summary.installed, ready: summary.ready });
}

/** Computer control's row names the providers agents may use, the default first ("Cua", "Cua and Agent Desktop"). */
export function describeMachineComputerUse(settings: ComputerUseSettingsV1): string {
    const names = [settings.defaultProvider, ...settings.enabledProviders.filter((provider) => provider !== settings.defaultProvider)]
        .map((provider) => COMPUTER_PROVIDER_DISPLAY_NAMES[provider]);
    return names.length === 2 ? t('computerUse.providers.summaryPair', { first: names[0]!, second: names[1]! }) : names[0]!;
}

/**
 * Details' row: the host name and platform. A machine Happier created is named by its provider with a generated
 * instance id, so its row says the platform alone; the Details page keeps every fact (copy rule: no raw ids).
 */
export function describeMachineDetailsSummary(input: Readonly<{ host: string | undefined; platform: string | undefined; managed: boolean }>): string | undefined {
    return [input.managed ? undefined : input.host, input.platform].filter(Boolean).join(' · ') || undefined;
}

/**
 * The Security tab's Setup row, from the daemon's published setup observation (MR7: a row fact read when the tab opens,
 * never a plan). Before the Machine publishes one, the row names what Setup holds.
 */
export function describeMachineSetupRowSummary(observation: Readonly<{ status: string; recipes: readonly unknown[] }> | null | undefined):
    Readonly<{ title: string; subtitle: string | undefined }> {
    if (!observation) return { title: t('machineDetailPage.security.setupRowUnknown'), subtitle: undefined };
    const count = observation.recipes.length;
    const title = count === 0 ? t('machineDetailPage.security.setupRowNone') : t('machineDetailPage.security.setupRowRecipes', { count });
    const subtitle = observation.status === 'drifted' ? t('machineDetailPage.security.setupRowDrifted')
        : observation.status === 'checking' ? t('machineDetailPage.security.setupRowChecking') : undefined;
    return { title, subtitle };
}

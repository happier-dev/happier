import { t } from '@/text';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ProviderGatewayChoiceResultV1 } from '@happier-dev/protocol/providers/gatewayContributionsV1';
import type { ConnectedServicesIndexModel, ConnectedServicesIndexSheet } from '../model/buildConnectedServicesIndexModel';
import { buildConnectedServiceSetupCatalog, connectedServiceSetupCategory, selectNewPoolServices } from '../setup/buildConnectedServiceSetupCatalog';
import { buildNewConnectedAccountPoolRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { buildConnectedServicesGatewayRoute } from './connectedServicesCollectionRoutes';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { ConnectSheetKeyRequest } from '../setup/ConnectedServiceSetupModal';

export type ConnectedServicesAddChoice = Readonly<{
    key: string;
    category: 'secrets' | 'voice' | 'agent-sign-in' | 'pools' | 'gateways' | 'code-tools' | 'cloud-machines' | 'plugins' | 'unknown';
    title: string;
    purpose: string | null;
    addedCount: number | null;
    disabled: boolean;
    reason: string | null;
    serviceKey?: string;
    contributionKey?: string;
} & (
    { kind: 'account'; service: PluginContributionIdentityV1; href: null }
    | { kind: 'key'; service: ConnectSheetKeyRequest['service']; bindingTarget?: ConnectSheetKeyRequest['bindingTarget']; href: null }
    | { kind: 'pool' | 'gateway'; href: string | ReturnType<typeof buildNewConnectedAccountPoolRoute> | null }
)>;

/** Shared pool menu data; the trigger/mark remains the existing menu's presentation. */
export function buildConnectedServicesPoolChoices(services: readonly ConnectedServicesIndexSheet[]): readonly ConnectedServicesAddChoice[] {
    return services.map((sheet): ConnectedServicesAddChoice => ({
        key: `pool:${sheet.serviceKey}`, kind: 'pool', serviceKey: sheet.serviceKey, category: 'pools',
        title: sheet.label, purpose: sheet.usedBy.join(' · ') || null, addedCount: sheet.groupCount,
        disabled: false, reason: null, href: buildNewConnectedAccountPoolRoute(sheet.service),
    }));
}

/** Descriptor-only menu input. Selection returns an account intent or a management draft route; it never creates or probes anything. */
export function buildConnectedServicesAddChoices(input: Readonly<{
    model: ConnectedServicesIndexModel;
    gateways: ProviderGatewayChoiceResultV1;
    gatewayAdmission: Readonly<{
        canAdd: boolean;
        reason: string | null;
        addedCountByContributionKey?: Readonly<Record<string, number | undefined>>;
    }>;
    gatewayPresentation: (key: string) => Readonly<{ title: string; purpose: string | null }>;
    includeSecret?: boolean;
    voiceProviders?: readonly Readonly<{ pluginId: string; declaration: VoiceProviderContribution }>[];
    localize?: (text: PluginLocalizedStringV2, pluginId: string) => string;
}>): readonly ConnectedServicesAddChoice[] {
    const catalog = buildConnectedServiceSetupCatalog(input.model);
    const accounts = catalog.map((entry): ConnectedServicesAddChoice => ({
        key: `account:${entry.serviceKey}`, kind: 'account', serviceKey: entry.serviceKey, service: entry.service,
        category: connectedServiceSetupCategory(entry),
        title: entry.label,
        purpose: typeof entry.entry?.projectedDescription === 'string' ? entry.entry.projectedDescription : entry.usedBy.join(' · ') || null,
        addedCount: entry.connectedCount, disabled: !entry.canAdd, reason: entry.statusLine ?? null,
        href: null,
    }));
    const pools = buildConnectedServicesPoolChoices(selectNewPoolServices(input.model));
    // A refusal may include candidates for explanation; it never grants a choice.
    const candidates = input.gateways.status === 'selected' ? [input.gateways.contribution]
        : input.gateways.status === 'choice_required' ? input.gateways.choices : [];
    const gateways = candidates.map((candidate): ConnectedServicesAddChoice => ({
        key: `gateway:${candidate.contributionKey}`, kind: 'gateway', category: 'gateways',
        contributionKey: candidate.contributionKey, ...input.gatewayPresentation(candidate.contributionKey),
        addedCount: input.gatewayAdmission.addedCountByContributionKey?.[candidate.contributionKey] ?? null,
        disabled: !input.gatewayAdmission.canAdd, reason: input.gatewayAdmission.reason,
        href: input.gatewayAdmission.canAdd ? buildConnectedServicesGatewayRoute({ contributionKey: candidate.contributionKey }) : null,
    }));
    const secret: ConnectedServicesAddChoice[] = input.includeSecret ? [{
        key: 'secret', kind: 'key', category: 'secrets', title: t('connectedServicesCollection.menuSecret'),
        service: { kind: 'key' }, href: null, purpose: null, addedCount: null, disabled: false, reason: null,
    }] : [];
    const voice = (input.voiceProviders ?? []).flatMap(({ pluginId, declaration }): ConnectedServicesAddChoice[] => {
        const credentials = declaration.credentials;
        const savedSecret = credentials?.sources.find(source => source.kind === 'savedSecret');
        if (!credentials || !savedSecret || savedSecret.kind !== 'savedSecret') return [];
        const localize = (text: PluginLocalizedStringV2) => input.localize?.(text, pluginId)
            ?? (typeof text === 'string' ? text : text.fallback);
        const title = localize(credentials.slot.title);
        return [{ key: `voice:${pluginId}/${declaration.id}/${credentials.slot.id}`, kind: 'key', category: 'voice',
            title, purpose: credentials.slot.description ? localize(credentials.slot.description) : null,
            service: { kind: 'key', suggestedName: title, keyKind: savedSecret.secretKinds[0] },
            bindingTarget: { kind: 'voice', contribution: { pluginId, localId: declaration.id }, slot: credentials.slot.id },
            href: null, addedCount: null, disabled: false, reason: null }];
    });
    return [...secret, ...accounts, ...voice, ...pools, ...gateways];
}

/**
 * The menu's one line when services can't be added only because no machine that runs them answers: said once
 * for the menu, never as a "Blocked" under each entry. A disabled entry with its own reason keeps that reason.
 */
export function presentConnectedServicesAddMenuNotice(choices: readonly ConnectedServicesAddChoice[]): string | null {
    return choices.some((choice) => choice.kind === 'account' && choice.disabled && !choice.reason)
        ? t('connectedServicesCollection.menuWaitingForMachine')
        : null;
}

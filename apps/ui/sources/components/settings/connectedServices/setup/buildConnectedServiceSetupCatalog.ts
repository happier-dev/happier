import type { ConnectedServicesIndexModel, ConnectedServicesIndexSheet } from '../model/buildConnectedServicesIndexModel';
import type { ConnectedServiceSetupCatalogEntry } from './ConnectedServiceSetupPanel';
import { getConnectedServiceSetupPresentation } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { t } from '@/text';

export type ConnectedServiceSetupCategory = 'agent-sign-in' | 'code-tools' | 'cloud-machines' | 'plugins' | 'unknown';

/** Presentation only: authored cloud placement wins, then plugin provenance and Agent usage. */
export function connectedServiceSetupCategory(
    entry: Pick<ConnectedServiceSetupCatalogEntry, 'category' | 'entry' | 'section'>,
): ConnectedServiceSetupCategory {
    return entry.category === 'cloud-machines' ? 'cloud-machines'
        : entry.entry?.projectedDescriptor?.provenance === 'external' ? 'plugins'
            : entry.section === 'unknown' ? 'unknown'
                : entry.section === 'agents' ? 'agent-sign-in' : 'code-tools';
}

/** The group's title, one wording for the Add menu and the Connect a service page. */
export function connectedServiceSetupCategoryTitle(category: ConnectedServiceSetupCategory): string {
    switch (category) {
        case 'agent-sign-in': return t('connectedServicesCollection.agentSignInGroup');
        case 'code-tools': return t('connectedServicesSettings.codeAndToolsTitle');
        case 'cloud-machines': return t('connectedServicesCollection.menuCloudMachines');
        case 'plugins': return t('connectedServicesCollection.menuFromPlugins');
        case 'unknown': return t('common.loading');
    }
}

/** One pool eligibility projection for the existing Pools menu and grouped Add adapter. */
export function selectNewPoolServices(model: ConnectedServicesIndexModel): readonly ConnectedServicesIndexSheet[] {
    return model.sheets.filter(sheet => sheet.section === 'agents' && sheet.canAdd
        && sheet.accounts.some(account => account.kind === 'qualified'));
}

/**
 * The setup catalog from the Connected services index: every service an online machine publishes,
 * with who would use it and how many accounts you already have. Services with accounts can take
 * another; services without are the invitation's (G3) list. One owner for every host of the panel.
 */
export function buildConnectedServiceSetupCatalog(
    model: ConnectedServicesIndexModel,
): readonly ConnectedServiceSetupCatalogEntry[] {
    const entries: ConnectedServiceSetupCatalogEntry[] = [
        ...model.sheets.map((sheet): ConnectedServiceSetupCatalogEntry => ({
            serviceKey: sheet.serviceKey,
            service: sheet.service,
            entry: sheet.entry,
            legacyServiceId: sheet.legacyServiceId,
            label: sheet.label,
            usedBy: sheet.usedBy,
            usedByAgentIds: sheet.usedByAgentIds,
            connectedCount: sheet.connectedCount,
            section: sheet.section,
            category: sheet.entry?.projectedDescriptor?.ui?.category,
            canAdd: sheet.canAdd,
            statusLine: sheet.statusLine,
            supportDetails: sheet.supportDetails,
        })),
        ...model.connectable.map((service): ConnectedServiceSetupCatalogEntry => ({
            serviceKey: service.serviceKey,
            service: service.service,
            entry: service.entry,
            legacyServiceId: service.entry.legacyServiceId ?? null,
            label: service.label,
            usedBy: service.usedBy,
            usedByAgentIds: service.usedByAgentIds,
            connectedCount: 0,
            section: service.section,
            category: service.entry.projectedDescriptor?.ui?.category,
            canAdd: true,
        })),
    ];
    return entries.map(entry => ({ ...entry, category: connectedServiceSetupCategory(entry) })).sort((left, right) =>
        (getConnectedServiceSetupPresentation(left.service, left.entry)?.order ?? Infinity)
        - (getConnectedServiceSetupPresentation(right.service, right.entry)?.order ?? Infinity)
        || left.label.localeCompare(right.label));
}

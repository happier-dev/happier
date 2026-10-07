import type { ConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import type { ConnectedServiceSetupCatalogEntry } from './ConnectedServiceSetupPanel';
import { getConnectedServiceSetupPresentation } from '@/sync/domains/connectedServices/connectedServiceRegistry';

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
            canAdd: true,
        })),
    ];
    return entries.sort((left, right) =>
        (getConnectedServiceSetupPresentation(left.service)?.order ?? Infinity)
        - (getConnectedServiceSetupPresentation(right.service)?.order ?? Infinity)
        || left.label.localeCompare(right.label));
}

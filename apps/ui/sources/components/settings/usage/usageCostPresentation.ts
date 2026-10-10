import { t } from '@/text';

/** Labels for the canonical money basis; no accounting decisions live in presentation. */
export function usageCostKindPhrase(kind: string): string {
  switch (kind) {
    case 'api_equivalent':
    case 'provider_reported_api_equivalent': return t('usage.board.page.kindApiEquivalent');
    case 'invoice': return t('usage.board.page.kindInvoice');
    case 'reported':
    case 'provider_reported': return t('usage.board.page.kindReported');
    case 'estimated':
    case 'pricing_estimate': return t('usage.board.page.kindEstimated');
    case 'unpriced': return t('usage.board.page.kindUnpriced');
    default: return t('usage.board.page.kindMixed');
  }
}

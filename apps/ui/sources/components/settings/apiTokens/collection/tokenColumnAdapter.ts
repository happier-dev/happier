import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import { buildApiTokenRowPresentation } from '../apiTokenSettingsPresentation';

export const tokenColumnAdapter = defineSettingsCollectionAdapter(['status']);
/** Only summary data crosses this seam. No token material, minting or expiry clock is created here. */
export function tokenColumnFacts(row: AccountApiTokenSummaryV1, nowMs: number, context: string | null): SettingsCollectionRowFacts<'status'> {
    const presentation = buildApiTokenRowPresentation({ token: row, nowMs });
    return { key: row.tokenId, title: row.label, context, status: presentation.status === 'active' ? null : presentation.status,
        fields: { status: [presentation.status] } };
}

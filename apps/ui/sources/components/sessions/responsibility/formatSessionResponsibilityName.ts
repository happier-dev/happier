import type { AccountDisplayProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { t } from '@/text';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

/**
 * The visible name for one neutral Account display profile.
 *
 * A profile with no name at all is a real state (an Account that has not filled
 * in a profile yet), so it gets an explicit label rather than an empty row or a
 * raw Account identifier.
 */
export function formatSessionResponsibilityName(profile: AccountDisplayProfileV1): string {
    return formatAccountDisplayName(profile) ?? t('session.responsibilityUnnamedPerson');
}

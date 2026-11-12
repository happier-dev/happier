import type { ManagedDefaultDecision } from '@happier-dev/protocol/teams/managedDefaults';
import { t } from '@/text';

/** Names the Team or Group whose member default a New Session choice inherited; null for every other source. */
export function describeInheritedDefaultSource(source: ManagedDefaultDecision<unknown>['source'] | null | undefined): string | null {
    if (source === 'team') return t('teams.settings.memberDefaults.teamDefault');
    if (source === 'group') return t('teams.settings.memberDefaults.groupDefault');
    return null;
}

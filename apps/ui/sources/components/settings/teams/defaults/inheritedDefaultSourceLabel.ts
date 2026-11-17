import type { ManagedDefaultDecision, ManagedDefaultSourceNamesV1 } from '@happier-dev/protocol/teams/managedDefaults';
import { t } from '@/text';

/** The names a source word uses; each comes from the admitted read that decided the default, never from a guess. */
export type InheritedDefaultSourceNames = ManagedDefaultSourceNamesV1;

/**
 * The one source word on a picker's selected row (lab L11 vocabulary): "Yours" for your own layers, the Team's
 * name, "Team · project" for the project's shared defaults. Null for a value chosen here or the Agent's own default.
 */
export function describeInheritedDefaultSource(
    source: ManagedDefaultDecision<unknown>['source'] | null | undefined,
    names?: InheritedDefaultSourceNames,
): string | null {
    switch (source) {
        case 'personal-project':
        case 'member':
            return t('teams.settings.memberDefaults.sourceYours');
        case 'project':
            return names?.projectName
                ? names.teamName
                    ? t('teams.settings.memberDefaults.sourceTeamProject', { team: names.teamName, project: names.projectName })
                    : names.projectName
                : t('teams.settings.memberDefaults.projectDefault');
        case 'team':
            return names?.teamName ?? t('teams.settings.memberDefaults.teamDefault');
        case 'group':
            return t('teams.settings.memberDefaults.groupDefault');
        case 'machine':
            return t('teams.settings.memberDefaults.machineDefault');
        case 'home':
            return t('teams.settings.memberDefaults.homeDefault');
        case 'policy':
            return names?.organization ?? t('teams.settings.memberDefaults.policyDefault');
        default:
            return null;
    }
}

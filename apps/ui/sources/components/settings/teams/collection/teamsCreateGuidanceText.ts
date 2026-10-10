import { t } from '@/text';

import type { TeamsCreateRefusal } from './teamsCreateGuidance';

/** Past this many administrators a sentence names the first two and counts the rest. */
const NAMED_ADMINISTRATORS_LIMIT = 3;

function administratorList(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length > NAMED_ADMINISTRATORS_LIMIT) {
    return t('teams.directory.namesAndOthers', {
      names: names.slice(0, 2).join(', '),
      count: names.length - 2,
    });
  }
  return t('teams.directory.namesAnd', {
    names: names.slice(0, -1).join(', '),
    last: names[names.length - 1]!,
  });
}

/**
 * "Ask Ana Silva and Leeroy Brun." — who to ask when only a Home owner can lift something, in the
 * same naming rule as Team creation. With no names known it still says who can, not just "no".
 */
export function askAdministratorsText(names: readonly string[]): string {
  return names.length > 0
    ? t('teams.authentication.add.askNamed', {
        names: administratorList(names),
      })
    : t('teams.authentication.add.askUnnamed');
}

/**
 * "Ask Ana Silva and Leeroy Brun." — who to ask when a Team's owners and admins can change something
 * the viewer cannot. Same naming rule; with no names known it says who can, in the Team's terms.
 */
export function askTeamManagersText(names: readonly string[]): string {
  return names.length > 0
    ? t('teams.authentication.add.askNamed', {
        names: administratorList(names),
      })
    : t('teams.denied.askUnnamed');
}

/** What the Teams page says in place of a create action nobody in view can take here. */
export function teamsCreateRefusalText(refusal: TeamsCreateRefusal): string {
  switch (refusal.kind) {
    case 'administered':
      return refusal.administratorNames.length > 0
        ? t('teams.directory.createAdministered', {
            names: administratorList(refusal.administratorNames),
          })
        : t('teams.directory.createAdministeredUnnamed');
    case 'off':
      return t('teams.directory.createOff');
    case 'denied':
      return t('teams.directory.createDenied', {
        homes: refusal.homeNames.join(', '),
      });
  }
}

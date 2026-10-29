
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * The user-invocable Home-governance intents.
 *
 * This module owns the family's vocabulary and nothing else. Each intent's
 * transport path and its strict input/output contract are declared once on its
 * Action row, and every lookup is derived from those rows — a schema or path
 * table here would be a second declaration of the same facts.
 *
 * The ids live in the domain rather than beside the rows so the shared Action id
 * registry can consume them without importing the Action spec module.
 */
export const HOME_GOVERNANCE_ACTION_IDS_V1 = [
  'home.governance.get',
  'home.governance.eligibility.get',
  'home.emptiness.get',
  'home.governance.claim',
  'home.accounts.list',
  'home.accounts.search',
  'home.accounts.get',
  'home.accounts.role.set',
  'home.accounts.disable',
  'home.accounts.enable',
  'home.accounts.delete',
  'home.accounts.signOutEverywhere',
  'home.public_profiles.restrict',
  'home.public_profiles.restore',
  'home.public_profiles.handle_reclaim',
  'home.policy.set',
  'home.settings.get',
  'home.settings.set',
  'home.mailDelivery.get',
  'home.mailDelivery.test',
  'home.audit.list',
  'home.reachability.get',
  'home.reachability.iroh.set',
  'home.retention.dryRun',
  'home.search.rebuild',
] as const;

export const SKILL_CREATE_ACTION_ID_V1 = 'skills.create';
export const SKILL_ACTION_IDS_V1 = ['skills.read', 'skills.list', SKILL_CREATE_ACTION_ID_V1, 'skills.update', 'skills.duplicate', 'skills.delete',
  'skills.install', 'skills.export', 'skills.updates.diff', 'skills.updates.apply', 'skills.found.list', 'skills.found.adopt', 'skills.found.read',
  'skills.machine.install', 'skills.machine.uninstall'] as const;
export type SkillActionIdV1 = (typeof SKILL_ACTION_IDS_V1)[number];

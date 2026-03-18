export const CHECKLIST_IDS = {
  NEW_SESSION: 'new-session',
  MACHINE_DETAILS: 'machine-details',
} as const;

export type ResumeChecklistId = `resume.${string}`;
export type ChecklistId = (typeof CHECKLIST_IDS)[keyof typeof CHECKLIST_IDS] | ResumeChecklistId;

export function resumeChecklistId<const TAgentId extends string>(agentId: TAgentId): `resume.${TAgentId}` {
  return `resume.${agentId}` as `resume.${TAgentId}`;
}

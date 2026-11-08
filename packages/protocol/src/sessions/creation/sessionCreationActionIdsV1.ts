/** Existing public roots whose Session birth carries an Action-child creation proof. */
export function isSessionActionChildCreationRootV1(actionId: string): boolean {
  return actionId === 'discussion.second_opinion.start' || actionId === 'deployments.prepare';
}

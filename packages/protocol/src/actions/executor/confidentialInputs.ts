export function isNativeSecretFillAction(actionId: string): boolean {
  return actionId === 'computer.secret.fill' || actionId === 'browser.automation.secret.fill';
}

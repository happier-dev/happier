import { expect, type Page } from '@playwright/test';

export type CreateAccountAndReachConnectMachineStatePage = Pick<Page, 'getByTestId'>;

export async function dismissSetupWizardIfVisible(params: Readonly<{
  page: CreateAccountAndReachConnectMachineStatePage;
}>): Promise<void> {
  const setupWizard = params.page.getByTestId('setupWizard.surface');
  if ((await setupWizard.count()) === 0) {
    return;
  }

  const skipSetup = params.page.getByTestId('setupWizard.surface-skip');
  await expect.poll(async () => await skipSetup.count(), { timeout: 60_000 }).toBe(1);
  await skipSetup.click();
  await expect.poll(async () => await setupWizard.count(), { timeout: 120_000 }).toBe(0);
}

export async function createAccountAndReachConnectMachineState(params: Readonly<{
  page: CreateAccountAndReachConnectMachineStatePage;
  useFirstCreateButton?: boolean | undefined;
}>): Promise<void> {
  const createAccount = params.page.getByTestId('welcome-create-account');
  const createButton = params.useFirstCreateButton === true ? createAccount.first() : createAccount;

  await expect.poll(async () => await createButton.count(), { timeout: 60_000 }).toBe(1);
  await createButton.click();

  const connectMachine = params.page.getByTestId('session-getting-started-kind-connect_machine');
  const setupWizard = params.page.getByTestId('setupWizard.surface');

  await expect
    .poll(async () => {
      return (await connectMachine.count()) > 0 || (await setupWizard.count()) > 0;
    }, { timeout: 120_000 })
    .toBe(true);

  await dismissSetupWizardIfVisible({ page: params.page });
  await expect.poll(async () => await connectMachine.count(), { timeout: 120_000 }).toBe(1);
}

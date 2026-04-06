import { expect, type Page } from '@playwright/test';

export type CreateAccountAndReachConnectMachineStatePage = Pick<Page, 'getByTestId'> & Partial<Pick<Page, 'evaluate'>>;

async function countAuthenticatedShellSurfaces(page: CreateAccountAndReachConnectMachineStatePage): Promise<number> {
  return (
    (await page.getByTestId('setup.postAuth').count())
    + (await page.getByTestId('sidebar-expand-button').count())
    + (await page.getByTestId('session-composer-input').count())
    + (await page.getByTestId('session-getting-started-kind-connect_machine').count())
  );
}

async function navigateToSetupWizard(page: CreateAccountAndReachConnectMachineStatePage): Promise<void> {
  if (!page.evaluate) {
    throw new Error('createAccountAndReachSetupWizardState requires page.evaluate to navigate to /setup/wizard');
  }
  await page.evaluate(() => {
    window.history.pushState({}, '', '/setup/wizard');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

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
  const connectMachine = params.page.getByTestId('session-getting-started-kind-connect_machine');
  const setupWizard = params.page.getByTestId('setupWizard.surface');

  let initialState: 'create-account' | 'connect-machine' | 'setup-wizard' | null = null;
  await expect
    .poll(async () => {
      if ((await createButton.count()) > 0) {
        initialState = 'create-account';
        return true;
      }
      if ((await connectMachine.count()) > 0) {
        initialState = 'connect-machine';
        return true;
      }
      if ((await setupWizard.count()) > 0) {
        initialState = 'setup-wizard';
        return true;
      }
      initialState = null;
      return false;
    }, { timeout: 60_000 })
    .toBe(true);

  if (initialState === 'create-account') {
    await createButton.click();
  }

  await expect
    .poll(async () => {
      return (await connectMachine.count()) > 0 || (await setupWizard.count()) > 0;
    }, { timeout: 120_000 })
    .toBe(true);

  await dismissSetupWizardIfVisible({ page: params.page });
  await expect.poll(async () => await connectMachine.count(), { timeout: 120_000 }).toBe(1);
}

export async function createAccountAndReachSetupWizardState(params: Readonly<{
  page: CreateAccountAndReachConnectMachineStatePage;
  useFirstCreateButton?: boolean | undefined;
}>): Promise<void> {
  const createAccount = params.page.getByTestId('welcome-create-account');
  const createButton = params.useFirstCreateButton === true ? createAccount.first() : createAccount;
  const setupWizard = params.page.getByTestId('setupWizard.surface');

  let initialState: 'create-account' | 'setup-wizard' | null = null;
  await expect
    .poll(async () => {
      if ((await createButton.count()) > 0) {
        initialState = 'create-account';
        return true;
      }
      if ((await setupWizard.count()) > 0) {
        initialState = 'setup-wizard';
        return true;
      }
      if ((await countAuthenticatedShellSurfaces(params.page)) > 0) {
        initialState = null;
        return true;
      }
      initialState = null;
      return false;
    }, { timeout: 60_000 })
    .toBe(true);

  if (initialState === 'create-account') {
    await createButton.click();
  }

  await expect
    .poll(async () => {
      return (await setupWizard.count()) > 0 || (await countAuthenticatedShellSurfaces(params.page)) > 0;
    }, { timeout: 120_000 })
    .toBe(true);

  if ((await setupWizard.count()) === 0) {
    await navigateToSetupWizard(params.page);
  }

  await expect.poll(async () => await setupWizard.count(), { timeout: 120_000 }).toBe(1);
}

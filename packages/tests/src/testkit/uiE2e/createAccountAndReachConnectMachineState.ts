import { expect, type Page } from '@playwright/test';

export type CreateAccountAndReachConnectMachineStatePage = Pick<Page, 'getByTestId'> & Partial<Pick<Page, 'evaluate'>>;

async function hasPersistedAuthCredentials(page: CreateAccountAndReachConnectMachineStatePage): Promise<boolean> {
    if (!page.evaluate) return true;

    try {
        const result = await page.evaluate(() => {
            if (typeof window === 'undefined' || !window.localStorage) return true;

            const validCredentialKeys: string[] = [];
            let activeServerId: string | null = null;

            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (!key) continue;
                const raw = window.localStorage.getItem(key);
                if (!raw) continue;

                if (key.includes('server-state-v1')) {
                    try {
                        const parsed = JSON.parse(raw) as {
                            activeServerId?: unknown;
                        };
                        const candidateActiveServerId = typeof parsed?.activeServerId === 'string'
                            ? parsed.activeServerId.trim()
                            : '';
                        if (candidateActiveServerId) {
                            activeServerId = candidateActiveServerId;
                        }
                    } catch {
                        // ignore malformed server state
                    }
                    continue;
                }

                if (key !== 'auth_credentials' && !key.startsWith('auth_credentials__srv_')) continue;

                try {
                    const parsed = JSON.parse(raw) as {
                        token?: unknown;
                        secret?: unknown;
                        encryption?: { publicKey?: unknown; machineKey?: unknown } | null;
                    };
                    const hasToken = typeof parsed?.token === 'string' && parsed.token.trim().length > 0;
                    const hasLegacySecret = typeof parsed?.secret === 'string' && parsed.secret.trim().length > 0;
                    const hasEncryption =
                        typeof parsed?.encryption?.publicKey === 'string'
                        && parsed.encryption.publicKey.trim().length > 0
                        && typeof parsed?.encryption?.machineKey === 'string'
                        && parsed.encryption.machineKey.trim().length > 0;
                    if (hasToken && (hasLegacySecret || hasEncryption)) {
                        validCredentialKeys.push(key);
                    }
                } catch {
                    continue;
                }
            }

            if (validCredentialKeys.length === 0) return false;
            if (!activeServerId) return true;

            const expectedKeyFragment = `auth_credentials__srv_${activeServerId.toLowerCase()}`;
            return validCredentialKeys.some((key) => key.toLowerCase().includes(expectedKeyFragment));
        });

        return typeof result === 'boolean' ? result : true;
    } catch {
        return true;
  }
}

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
      const createAccountVisible = (await createButton.count()) > 0;
      if (createAccountVisible) {
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
      const createAccountVisible = (await createButton.count()) > 0;
      if ((await setupWizard.count()) > 0) return true;
      if (createAccountVisible) return false;
      return (await connectMachine.count()) > 0;
    }, { timeout: 120_000 })
    .toBe(true);

  await dismissSetupWizardIfVisible({ page: params.page });
  await expect.poll(async () => {
    if ((await createButton.count()) > 0) return 0;
    if ((await connectMachine.count()) !== 1) return 0;
    return (await hasPersistedAuthCredentials(params.page)) ? 1 : 0;
  }, { timeout: 120_000 }).toBe(1);
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

import { expect, type Page } from '@playwright/test';

export type CreateAccountAndReachConnectMachineStatePage = Pick<Page, 'getByTestId'> & Partial<Pick<Page, 'evaluate'>>;
type TestIdLocator = ReturnType<Page['getByTestId']>;

const PRE_AUTH_PROGRESS_CTA_TEST_IDS = [
  'brand-hero-get-started',
] as const;

const CREATE_ACCOUNT_CTA_TEST_IDS = [
  'welcome-primary-start',
  'welcome-create-account',
] as const;

async function isVisible(locator: TestIdLocator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function clickCreateAccountButton(createButton: TestIdLocator | null): Promise<void> {
  if (!createButton) {
    throw new Error('Expected a visible create-account button before account creation');
  }
  await createButton.click();
}

async function trySwitchToSessionsTab(params: Readonly<{
  page: CreateAccountAndReachConnectMachineStatePage;
  switchedRef: { current: boolean };
}>): Promise<boolean> {
  if (params.switchedRef.current) {
    return false;
  }

  const sessionsTab = params.page.getByTestId('tabbar-tab-sessions');
  if (!(await isVisible(sessionsTab))) {
    return false;
  }

  try {
    await sessionsTab.click();
    params.switchedRef.current = true;
    return true;
  } catch {
    return false;
  }
}

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
    + (await page.getByTestId('session-getting-started-kind-start_daemon').count())
    + (await page.getByTestId('session-getting-started-kind-create_session').count())
    + (await page.getByTestId('session-getting-started-kind-select_session').count())
    + (await page.getByTestId('sessions-empty-state-open-setup').count())
    + (await page.getByTestId('main-header-start-new-session').count())
  );
}

async function isAuthenticatedSessionHomeVisible(page: CreateAccountAndReachConnectMachineStatePage): Promise<boolean> {
  const connectMachine = page.getByTestId('session-getting-started-kind-connect_machine');
  if (await isVisible(connectMachine)) return true;

  const startDaemon = page.getByTestId('session-getting-started-kind-start_daemon');
  if (await isVisible(startDaemon)) return true;

  const createSession = page.getByTestId('session-getting-started-kind-create_session');
  if (await isVisible(createSession)) return true;

  const selectSession = page.getByTestId('session-getting-started-kind-select_session');
  if (await isVisible(selectSession)) return true;

  const openSetup = page.getByTestId('sessions-empty-state-open-setup');
  if (await isVisible(openSetup)) return true;

  const startNewSession = page.getByTestId('main-header-start-new-session');
  if (await isVisible(startNewSession)) return true;

  return false;
}

async function hasDurableAuthenticatedSessionHomeVisible(
  page: CreateAccountAndReachConnectMachineStatePage,
): Promise<boolean> {
  const createSession = page.getByTestId('session-getting-started-kind-create_session');
  if (await isVisible(createSession)) return true;

  const selectSession = page.getByTestId('session-getting-started-kind-select_session');
  if (await isVisible(selectSession)) return true;

  const startNewSession = page.getByTestId('main-header-start-new-session');
  if (await isVisible(startNewSession)) return true;

  return false;
}

async function findVisibleCreateAccountButton(params: Readonly<{
  page: CreateAccountAndReachConnectMachineStatePage;
  useFirstCreateButton?: boolean | undefined;
}>): Promise<ReturnType<Page['getByTestId']> | null> {
  for (const testId of CREATE_ACCOUNT_CTA_TEST_IDS) {
    const locator = params.page.getByTestId(testId);
    const candidate = params.useFirstCreateButton === true ? locator.first() : locator;
    if (await isVisible(candidate)) return candidate;
  }
  return null;
}

async function clickPreAuthProgressButtonIfPresent(
  page: CreateAccountAndReachConnectMachineStatePage,
): Promise<boolean> {
  for (const testId of PRE_AUTH_PROGRESS_CTA_TEST_IDS) {
    const locator = page.getByTestId(testId);
    if (!(await isVisible(locator))) continue;
    await locator.click();
    return true;
  }
  return false;
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
  requirePersistedAuthCredentials?: boolean | undefined;
}>): Promise<void> {
  const setupWizard = params.page.getByTestId('setupWizard.surface');
  const switchedToSessionsTabRef = { current: false };
  let initialCreateButton: TestIdLocator | null = null;

  let initialState: 'create-account' | 'authenticated-home' | 'setup-wizard' | null = null;
  await expect
    .poll(async () => {
      if (await clickPreAuthProgressButtonIfPresent(params.page)) {
        initialState = null;
        return false;
      }
      const createButton = await findVisibleCreateAccountButton(params);
      if (createButton) {
        initialCreateButton = createButton;
        initialState = 'create-account';
        return true;
      }
      if (await isAuthenticatedSessionHomeVisible(params.page)) {
        initialState = 'authenticated-home';
        return true;
      }
      if (await isVisible(setupWizard)) {
        initialState = 'setup-wizard';
        return true;
      }
      if (await trySwitchToSessionsTab({ page: params.page, switchedRef: switchedToSessionsTabRef })) {
        initialState = null;
        return false;
      }
      initialState = null;
      return false;
    }, { timeout: 60_000 })
    .toBe(true);

  if (initialState === 'create-account') {
    await clickCreateAccountButton(initialCreateButton);
  }

  await expect
    .poll(async () => {
      if (await clickPreAuthProgressButtonIfPresent(params.page)) return false;
      const createAccountVisible = (await findVisibleCreateAccountButton(params)) !== null;
      if (await isVisible(setupWizard)) return true;
      if (createAccountVisible) return false;
      if (await trySwitchToSessionsTab({ page: params.page, switchedRef: switchedToSessionsTabRef })) {
        return false;
      }
      return isAuthenticatedSessionHomeVisible(params.page);
    }, { timeout: 120_000 })
    .toBe(true);

  await dismissSetupWizardIfVisible({ page: params.page });
  const requirePersistedAuthCredentials = params.requirePersistedAuthCredentials !== false;

  await expect.poll(async () => {
    if ((await findVisibleCreateAccountButton(params)) !== null) return 0;
    if (!(await isAuthenticatedSessionHomeVisible(params.page))) return 0;
    if (!requirePersistedAuthCredentials) return 1;
    if (await hasDurableAuthenticatedSessionHomeVisible(params.page)) return 1;
    return (await hasPersistedAuthCredentials(params.page)) ? 1 : 0;
  }, { timeout: 120_000 }).toBe(1);
}

export async function createAccountAndReachSetupWizardState(params: Readonly<{
  page: CreateAccountAndReachConnectMachineStatePage;
  useFirstCreateButton?: boolean | undefined;
}>): Promise<void> {
  const setupWizard = params.page.getByTestId('setupWizard.surface');
  let initialCreateButton: TestIdLocator | null = null;

  let initialState: 'create-account' | 'setup-wizard' | null = null;
  await expect
    .poll(async () => {
      if (await clickPreAuthProgressButtonIfPresent(params.page)) {
        initialState = null;
        return false;
      }
      const createButton = await findVisibleCreateAccountButton(params);
      if (createButton) {
        initialCreateButton = createButton;
        initialState = 'create-account';
        return true;
      }
      if (await isVisible(setupWizard)) {
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
    await clickCreateAccountButton(initialCreateButton);
  }

  await expect
    .poll(async () => {
      return (await isVisible(setupWizard)) || (await countAuthenticatedShellSurfaces(params.page)) > 0;
    }, { timeout: 120_000 })
    .toBe(true);

  if (!(await isVisible(setupWizard))) {
    await navigateToSetupWizard(params.page);
  }

  await expect.poll(async () => await setupWizard.count(), { timeout: 120_000 }).toBe(1);
}

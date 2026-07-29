export type CountableClickableLocator = Readonly<{
    count: () => Promise<number>;
    isVisible?: () => Promise<boolean>;
    getAttribute?: (name: string) => Promise<string | null>;
    click: (options?: Readonly<{ timeout?: number; force?: boolean }>) => Promise<void>;
}>;

export type CountableRoleScope = Readonly<{
    getByTestId: (testId: string) => CountableClickableLocator;
    getByRole: (role: 'button' | 'tab', options: Readonly<{ name: string; exact?: boolean }>) => CountableClickableLocator;
}>;

export async function clickScopedButtonByTestIdOrRole(params: Readonly<{
    scope: CountableRoleScope;
    testId: string;
    roleName: string;
    role?: 'button' | 'tab';
    expectedAriaSelected?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
    getNowMs?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}>): Promise<'testId' | 'role'> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const pollIntervalMs = params.pollIntervalMs ?? 250;
    const getNowMs = params.getNowMs ?? (() => Date.now());
    const sleep = params.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const startedAtMs = getNowMs();
    const testIdLocator = params.scope.getByTestId(params.testId);
    const role = params.role ?? 'button';
    const roleLocator = params.scope.getByRole(role, { name: params.roleName, exact: true });

    const isReadyToClick = async (locator: CountableClickableLocator): Promise<boolean> => {
        if (!(await locator.count())) return false;
        return locator.isVisible ? await locator.isVisible() : true;
    };

    const waitForExpectedSelection = async (locator: CountableClickableLocator): Promise<void> => {
        if (params.expectedAriaSelected === undefined) return;
        if (!locator.getAttribute) {
            throw new Error(`Cannot verify aria-selected for ${role} "${params.roleName}"`);
        }
        const expectedValue = String(params.expectedAriaSelected);
        for (;;) {
            if (await locator.getAttribute('aria-selected') === expectedValue) return;
            if (getNowMs() - startedAtMs >= timeoutMs) {
                throw new Error(`Timed out waiting for ${role} "${params.roleName}" to have aria-selected="${expectedValue}"`);
            }
            await sleep(pollIntervalMs);
        }
    };

    for (;;) {
        if (await isReadyToClick(testIdLocator)) {
            await testIdLocator.click({ timeout: timeoutMs });
            await waitForExpectedSelection(testIdLocator);
            return 'testId';
        }
        if (await isReadyToClick(roleLocator)) {
            await roleLocator.click({ timeout: timeoutMs });
            await waitForExpectedSelection(roleLocator);
            return 'role';
        }
        if (getNowMs() - startedAtMs >= timeoutMs) {
            throw new Error(`Timed out waiting for button by testID "${params.testId}" or role name "${params.roleName}"`);
        }
        await sleep(pollIntervalMs);
    }
}

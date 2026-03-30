export type CountableClickableLocator = Readonly<{
    count: () => Promise<number>;
    click: (options?: Readonly<{ timeout?: number; force?: boolean }>) => Promise<void>;
}>;

export type CountableRoleScope = Readonly<{
    getByTestId: (testId: string) => CountableClickableLocator;
    getByRole: (role: 'button', options: Readonly<{ name: string; exact?: boolean }>) => CountableClickableLocator;
}>;

export async function clickScopedButtonByTestIdOrRole(params: Readonly<{
    scope: CountableRoleScope;
    testId: string;
    roleName: string;
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
    const roleLocator = params.scope.getByRole('button', { name: params.roleName, exact: true });

    for (;;) {
        if (await testIdLocator.count()) {
            await testIdLocator.click({ timeout: timeoutMs, force: true });
            return 'testId';
        }
        if (await roleLocator.count()) {
            await roleLocator.click({ timeout: timeoutMs, force: true });
            return 'role';
        }
        if (getNowMs() - startedAtMs >= timeoutMs) {
            throw new Error(`Timed out waiting for button by testID "${params.testId}" or role name "${params.roleName}"`);
        }
        await sleep(pollIntervalMs);
    }
}

import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
    AutomationDefinitionListItem,
    AutomationDefinitionListResponse,
    AutomationV3RunListItem,
    AutomationV3RunListResponse,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import { resolveTestDbProvider, startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
    releaseFakeClaudeRuntimeContinuityTurn,
    waitForFakeClaudeRuntimeContinuityEffect,
} from '../../src/testkit/providers/fakeClaudeContinuity';
import { createSessionFromNewSessionComposer, openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

import { runCliJson } from '../../src/testkit/uiE2e/cliJson';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { SESSION_SPAWN_NEW_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { prepareAutomationsEverywhereDeployment } from '../../src/testkit/automationsEverywhereDeployment';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema, WorkflowRunListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { QualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { ApprovalQueueListResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

const run = createRunDirs({ runLabel: 'ui-e2e' });

/** Setup and arrival-point reads use the paired person's ordinary CLI Action entry. */
async function invokeP04Action(
    context: Readonly<{ testDir: string; cliHomeDir: string; serverUrl: string; uiBaseUrl: string }>,
    label: string,
    actionId: ActionId | QualifiedPluginActionId,
    input: unknown,
    target?: Readonly<{ machineId: string; projectDirectory?: string }>,
) {
    return runCliJson({ testDir: context.testDir, cliHomeDir: context.cliHomeDir,
        serverUrl: context.serverUrl, webappUrl: context.uiBaseUrl, label,
        env: { ...process.env, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' },
        launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
        args: ['actions', 'invoke', actionId, '--input-json', JSON.stringify(input), '--yes', '--json',
            ...(target ? ['--machine-id', target.machineId,
                ...(target.projectDirectory ? ['--project-directory', target.projectDirectory] : [])] : [])],
        acceptedExitCodes: [0, 1],
    });
}

/** Discover opaque UI addresses from the mounted person-facing surface, then use ordinary reverse dispatch. */
async function invokeP04MountedCommand(context: Parameters<typeof invokeP04Action>[0], label: string, title: RegExp) {
    const read = await invokeP04Action(context, `${label}-read`, 'ui.current_context.read', {});
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const commands = CurrentUiContextSnapshotV1Schema.parse(read.data).commands.filter(command => title.test(command.title));
    expect(commands, `Expected one mounted ${title} command`).toHaveLength(1);
    const invoked = await invokeP04Action(context, label, 'ui.current_context.command.invoke', { commandId: commands[0]!.id });
    expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
}

function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
}

async function clickLocatorWithFallback(locator: Locator): Promise<void> {
    try {
        await locator.click({ timeout: 15_000 });
    } catch {
        await locator.click({ timeout: 15_000, force: true });
    }
}

async function ensureSettingsSwitchEnabled(page: Page, testId: string) {
    const toggle = page.getByRole('switch').filter({ has: page.getByTestId(testId) });
    await expect(toggle).toHaveCount(1, { timeout: 60_000 });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
}

async function enableAutomationsInSettings(params: Readonly<{ baseUrl: string; page: Page }>) {
    await enableEnhancedSessionWizard({ page: params.page, baseUrl: params.baseUrl, timeoutMs: 180_000 });
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/features?happier_hmr=0`, 180_000);
    await ensureSettingsSwitchEnabled(params.page, 'settings-feature-experiments-toggle');
    await ensureSettingsSwitchEnabled(params.page, 'settings-feature-toggle-workflows');
}

async function selectMachineForNewSession(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    machineId: string;
}>) {
    const selectionResult = await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });

    if (selectionResult === 'picker_open') {
        const exact = params.page.locator(
            `[data-testid="new-session-machine:${params.machineId}"], [data-testid="new-session-machine-option:${params.machineId}"]`,
        );
        const anyOption = params.page.locator(
            '[data-testid^="new-session-machine:"], [data-testid^="new-session-machine-option:"]',
        );

        await expect.poll(async () => await anyOption.count(), { timeout: 120_000 }).toBeGreaterThan(0);
        if (await exact.count()) {
            await clickLocatorWithFallback(exact.first());
        } else {
            await clickLocatorWithFallback(anyOption.first());
        }
    }

    await params.page.waitForURL((url: URL) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });
}

async function readAuthTokenFromBrowserStorage(page: Page): Promise<string> {
    const token = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials')) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as { token?: unknown };
                if (typeof parsed.token === 'string' && parsed.token.trim()) {
                    return parsed.token.trim();
                }
            } catch {
                // ignore malformed storage entries and keep scanning
            }
        }
        return null;
    });

    if (typeof token === 'string' && token.trim()) {
        return token.trim();
    }
    throw new Error('Failed to read auth token from browser storage');
}

async function readMachineIdFromCliAuthLoginStdout(stdoutPath: string): Promise<string> {
    const stdout = (await readFile(stdoutPath, 'utf8')).replaceAll(/\u001b\[[0-9;]*m/g, '');
    const match = stdout.match(/Machine ID:\s*([^\s]+)/);
    if (match?.[1]) {
        return match[1].trim();
    }
    throw new Error(`Failed to read machine id from CLI auth login stdout: ${stdoutPath}`);
}

async function getJson<T>(params: Readonly<{
    baseUrl: string;
    token: string;
    path: string;
}>): Promise<T> {
    const response = await fetch(`${params.baseUrl}${params.path}`, {
        headers: {
            Authorization: `Bearer ${params.token}`,
        },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
}

type PersistedAutomationListItem = AutomationDefinitionListItem;
type PersistedAutomationRunRow = AutomationV3RunListItem;
type SessionMessagesResponse = Readonly<{
    messages: ReadonlyArray<Readonly<{
        localId: string | null;
        content: unknown;
    }>>;
}>;

function requirePollResult<T>(value: T | null, message: string): T {
    if (value === null) {
        throw new Error(message);
    }
    return value;
}

async function listPersistedAutomations(params: Readonly<{
    baseUrl: string;
    token: string;
}>): Promise<ReadonlyArray<PersistedAutomationListItem>> {
    const response = await getJson<AutomationDefinitionListResponse>({
        baseUrl: params.baseUrl,
        token: params.token,
        path: '/v3/automations',
    });
    return response.automations;
}

async function listPersistedAutomationRuns(params: Readonly<{
    baseUrl: string;
    token: string;
    automationId: string;
}>): Promise<ReadonlyArray<PersistedAutomationRunRow>> {
    const response = await getJson<AutomationV3RunListResponse>({
        baseUrl: params.baseUrl,
        token: params.token,
        path: `/v3/automations/${params.automationId}/runs?limit=20`,
    });
    return response.runs;
}

async function listSessionMessages(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
}>): Promise<SessionMessagesResponse> {
    return await getJson<SessionMessagesResponse>({
        baseUrl: params.baseUrl,
        token: params.token,
        path: `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?limit=100`,
    });
}

async function expectPersistedAutomation(params: Readonly<{
    baseUrl: string;
    token: string;
    name: string;
    targetType: 'newSession' | 'existingSession';
    existingSessionId?: string;
    expectedTriggers?: ReadonlyArray<Readonly<{ id: string; kind: string; everyMs: number | null }>>;
}>): Promise<string> {
    let persistedAutomationId: string | null = null;
    await expect.poll(async () => {
        const automations = await listPersistedAutomations({
            baseUrl: params.baseUrl,
            token: params.token,
        });
        const found = automations.find((automation) => automation.name === params.name);
        persistedAutomationId = found?.id ?? null;
        if (!found) return null;
        return {
            name: found.name,
            targetType: found.targetType,
            ...(params.existingSessionId !== undefined
                ? { existingSessionId: found.existingSessionId }
                : {}),
            triggers: found.triggers.map((trigger) => ({
                id: trigger.id,
                kind: trigger.kind,
                everyMs: trigger.kind === 'schedule' ? trigger.schedule.everyMs : null,
            })),
        };
    }, { timeout: 60_000 }).toEqual({
        name: params.name,
        targetType: params.targetType,
        ...(params.existingSessionId !== undefined
            ? { existingSessionId: params.existingSessionId }
            : {}),
        triggers: params.expectedTriggers ?? [],
    });
    if (persistedAutomationId === null) {
        throw new Error(`Automation ${params.name} was not persisted`);
    }
    return persistedAutomationId;
}

async function addScheduleTrigger(page: Page): Promise<string> {
    const rows = page.locator('[data-testid^="automation-trigger-row-"]');
    const previousCount = await rows.count();
    await page.getByTestId('automation-trigger-add').click();
    await page.getByTestId('automation-trigger-kind-schedule').click();
    await expect(rows).toHaveCount(previousCount + 1, { timeout: 30_000 });
    const testId = await rows.nth(previousCount).getAttribute('data-testid');
    if (!testId?.startsWith('automation-trigger-row-')) {
        throw new Error('Plural Automation editor did not expose the new trigger identity');
    }
    await page.getByTestId('automation-trigger-editor-done').click();
    return testId.slice('automation-trigger-row-'.length);
}

async function submitAutomationViaComposer(params: Readonly<{
    page: Page;
    testId: 'new-session-composer-send' | 'session-composer-send';
    expectedPathname: string;
}>) {
    const submit = params.page.getByTestId(params.testId);
    await expect(submit).toBeEnabled({ timeout: 60_000 });

    const [response] = await Promise.all([
        params.page.waitForResponse((candidate) => {
            try {
                return candidate.request().method() === 'POST'
                    && new URL(candidate.url()).pathname === '/v3/automations';
            } catch {
                return false;
            }
        }, { timeout: 60_000 }),
        params.page.waitForURL((url) => url.pathname === params.expectedPathname, { timeout: 60_000 }),
        submit.click(),
    ]);

    expect(response.ok()).toBe(true);
}

/** One independently identified trigger row id from its stable row testID. */
function triggerIdFromRowTestId(rowTestId: string | null): string {
    if (!rowTestId?.startsWith('automation-trigger-row-')) {
        throw new Error('Automation editor did not expose the trigger identity');
    }
    return rowTestId.slice('automation-trigger-row-'.length);
}

async function saveAutomationEditorViaSubmit(params: Readonly<{
    page: Page;
    automationId: string;
}>): Promise<void> {
    const [response] = await Promise.all([
        params.page.waitForResponse((candidate) => {
            try {
                return candidate.request().method() === 'PUT'
                    && new URL(candidate.url()).pathname === `/v3/automations/${params.automationId}`;
            } catch {
                return false;
            }
        }, { timeout: 60_000 }),
        params.page.getByTestId('automation-editor-submit').click(),
    ]);
    expect(response.ok()).toBe(true);
}

test.describe('ui e2e: automations authoring', () => {
    test.describe.configure({ mode: 'default' });

    const suiteDir = run.testDir('automations-authoring-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    const p04Daemons: StartedDaemon[] = [];

    /** Real Account, source-loaded browser and daemon; each case keeps its own credentials. */
    async function startP04AuthoringCase(page: Page, label: string, extraEnv: NodeJS.ProcessEnv = {}) {
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
        const testDir = resolve(join(suiteDir, label));
        const caseCliHomeDir = resolve(join(testDir, 'cli-home'));
        await mkdir(caseCliHomeDir, { recursive: true });
        await writeFile(resolve(join(caseCliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
        const caseDaemon = await authenticateAndStartDaemon({ page, testDir, cliHomeDir: caseCliHomeDir,
            serverUrl: server.baseUrl, uiBaseUrl, createAccount: false, extraEnv: {
                HOME: caseCliHomeDir, HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
                ...extraEnv,
            } });
        p04Daemons.push(caseDaemon);
        const accessKey = await readCliAccessKey(caseCliHomeDir);
        if (!accessKey) throw new Error('missing paired fixture credentials');
        const { token } = accessKey;
        const machineId = await readMachineIdFromCliAuthLoginStdout(resolve(join(testDir, 'cli.auth.login.stdout.log')));
        await enableAutomationsInSettings({ page, baseUrl: uiBaseUrl });
        return { serverUrl: server.baseUrl, uiBaseUrl, token, machineId, cliHomeDir: caseCliHomeDir,
            testDir, daemon: caseDaemon };
    }

    /** Saved deployment receipts supply real declared Event operands and repeated arrivals. */
    async function startP04DeploymentEventsCase(page: Page, label: string) {
        const toolsDir = resolve(join(suiteDir, `${label}-tools`));
        const docker = await createOwnServerDockerBoundary(toolsDir);
        const context = await startP04AuthoringCase(page, label, { PATH: `${toolsDir}${delimiter}${process.env.PATH ?? ''}` });
        const features = FeaturesResponseSchema.parse(await getJson({
            baseUrl: context.serverUrl, token: context.token, path: '/v1/features/authenticated',
        }));
        const serverId = features.capabilities.serverIdentity.serverIdentityId;
        if (!serverId) throw new Error('Home identity is unavailable');
        expect(features.homeConnectionDescriptor?.homeServerIdentityId, 'Fixture publishes its exact Home descriptor').toBe(serverId);
        let invocationNumber = 0;
        async function invoke(actionId: ActionId, input: unknown) {
            const reply = await invokeP04Action(context, `${label}-${++invocationNumber}`, actionId, input);
            if (!reply.ok) throw new Error(`${actionId}: ${JSON.stringify(reply.error)}`);
            return reply.data;
        }
        const source = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.create', {
            serverId, name: `${label} receipt source`, requestKey: randomUUID(),
        }));
        if (!source.ok) throw new Error(source.error);
        const deployment = await prepareAutomationsEverywhereDeployment({ serverId, projectSourceId: source.source.id,
            machine: { homeDir: context.cliHomeDir, target: { machineId: context.machineId } }, docker, invoke });
        const catalog = WorkflowEventsListOutputV1Schema.parse(await invoke('workflow.events.list', { machineId: context.machineId, serverId }));
        const event = catalog.events.find(row => row.event.identity.pluginId === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId
            && row.event.identity.localId === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId);
        if (!event?.observationBinding) throw new Error('Saved deployment receipt observer unavailable');
        const configured = await invokeP04Action(context, `${label}-configure-source`, 'action.invoke', {
            action: event.setupAction.identity, expectedContributorOccurrenceId: event.setupAction.occurrenceId,
            input: { v: 1, ...deployment },
        }, { machineId: context.machineId, projectDirectory: context.cliHomeDir });
        expect(configured.ok, JSON.stringify(configured)).toBe(true);
        const enrollment = PluginEventAutomationSetupResultV1Schema.parse(configured.data);
        const selection = WorkflowTriggerWriteResultV1Schema.parse(await invoke('workflow.trigger.add', {
            observationOnly: { kind: 'observationOnly' },
            trigger: { kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
                sourceInstanceId: enrollment.sourceInstanceId, sourceContractVersion: enrollment.sourceContractVersion,
                sourceConfig: enrollment.sourceConfig, displayLabel: enrollment.displayLabel,
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: event.observationBinding.materializationRef },
                subject: { kind: 'environment', serverId, environmentId: deployment.environmentId },
                filter: null, maximumObservationAgeMs: null } }));
        await docker.setActivationCommandFailure(true);
        return { context, serverId, event,
            arrive: async () => {
                const startingAt = Date.now();
                const result = await invokeP04Action(context, `${label}-arrival-${++invocationNumber}`,
                    DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployment);
                expect(result.ok, 'Native Deploy is expected to fail in this fixture').toBe(false);
                await expect.poll(async () => {
                    const status = WorkflowTriggerListResultV1Schema.parse(await invoke('workflow.trigger.list', {
                        automationId: selection.set.automationId,
                    })).sets[0]?.triggers.find(trigger => trigger.id === selection.triggerId);
                    return status?.kind === 'pluginEvent' ? status.sourceStatus?.lastObservedAt ?? 0 : 0;
                }, { message: 'The saved exact Environment watcher observed the native Deployment failure', timeout: 180_000 })
                    .toBeGreaterThanOrEqual(startingAt);
            } };
    }

    async function selectP04DeploymentFailure(page: Page, sourceName: string, { discardDraft = false } = {}) {
        const rows = page.locator('[data-testid^="workflows-column:events:row:"]');
        await rows.getByText(sourceName, { exact: true }).first().click();
        if (discardDraft) {
            await page.getByRole('dialog', { name: 'Discard changes', exact: true })
                .getByRole('button', { name: 'Discard', exact: true }).click();
        }
        await expect(page.getByTestId('workflow-events:detail:carries:result')).toContainText('Failed');
        await expect(page.getByTestId('workflow-events:detail:open')).toBeVisible();
    }

    async function openP04DeploymentFailure(page: Page, sourceName: string, arrive: () => Promise<void>) {
        await expect(page.getByTestId('workflows-column:events:listening:live')).toBeVisible();
        await arrive();
        await selectP04DeploymentFailure(page, sourceName);
    }

    async function configureP04DeploymentTrigger(page: Page, machineId: string, surface: 'workflow-editor' | 'workflow-builder') {
        await page.getByTestId(`${surface}-sentence-machine`).click();
        await page.getByTestId(`${surface}-sentence-machine-option:${machineId}`).click();
        await page.locator(`[data-testid^="${surface}-sentence-trigger:new:"][data-testid$="-detail"]`).click();
        await page.locator(`[data-testid^="${surface}-trigger:new:"][data-testid$="-configure-event"]`)
            .and(page.getByRole('button', { name: 'Source: Set up', exact: true })).click();
        await page.getByTestId('automation-event-configure-source').click();
        const submitSetup = page.getByTestId('plugin-contributed-action-form-submit').filter({ visible: true });
        const done = page.getByTestId('automation-plugin-event-done');
        const ready = page.locator('[data-testid="automation-plugin-event-done"]:not([aria-disabled="true"]):not([disabled]):visible');
        await expect(submitSetup.or(ready).first()).toBeVisible();
        if (await submitSetup.isVisible()) await submitSetup.click();
        await done.click();
        // The Configure Event surface closes on Done. Leave the sentence builder
        // open so its next interaction still edits the same draft.
    }

    async function addP04Action(page: Page, surface: 'workflow-editor' | 'workflow-builder', actionId: ActionId) {
        await page.getByTestId(`${surface}-sentence-add-step`).click();
        await page.getByRole('combobox', { name: 'Search', exact: true }).fill(actionId);
        await page.locator(`[data-testid$=":option:${surface}-sentence-add-step-menu-action:${actionId}"]`).click();
    }

    async function readP04Runs(context: Parameters<typeof invokeP04Action>[0], label: string, automationId: string) {
        const response = await invokeP04Action(context, label, 'workflow.run.list', { automationId });
        expect(response.ok).toBe(true);
        return WorkflowRunListResultV1Schema.parse(response.data).runs;
    }

    async function waitForP04Run(
        page: Page, context: Parameters<typeof invokeP04Action>[0], serverId: string, label: string, automationId: string,
    ) {
        const readRuns = () => readP04Runs(context, label, automationId);
        let run: Awaited<ReturnType<typeof readRuns>>[number] | undefined;
        let approvalId: string | undefined;
        await expect.poll(async () => {
            const runs = await readRuns();
            expect(runs.length).toBeLessThanOrEqual(1);
            run = runs[0];
            if (!run) return false;
            if (isTerminalAutomationRunStateV3(run.state)) return true;
            if (!run.invocationAttentionRequired) return false;
            const reply = await invokeP04Action(context, `${label}-approval`, 'approval.request.list', {
                workflowRunId: run.id, status: 'open',
            });
            expect(reply.ok).toBe(true);
            const approvals = ApprovalQueueListResultV1Schema.parse(reply.data).items;
            expect(approvals.length).toBeLessThanOrEqual(1);
            approvalId = approvals[0]?.artifactId;
            return approvalId !== undefined;
        }, { message: 'The later receipt starts a Run that settles or exposes its open approval', timeout: 180_000 }).toBe(true);
        if (!run) throw new Error('No Run started for the later receipt');
        if (!approvalId) return [run];

        await gotoDomContentLoadedWithRetries(page,
            `${context.uiBaseUrl}/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(serverId)}`);
        await page.getByTestId('approvals.approve').click();
        await expect.poll(async () => (await readRuns()).map(row => row.state), { timeout: 180_000 }).toEqual(['succeeded']);
        return readRuns();
    }

    test.beforeAll(async () => {
        test.setTimeout(900_000);
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        const port = await reserveAvailablePort();
        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: resolveTestDbProvider(process.env, { fallbackProvider: 'sqlite' }),
            port,
            extraEnv: {
                HAPPIER_PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_SERVER_URL: '',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_NO_DEV: '0',
            HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: '600000',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '900000',
        };

        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...uiWebEnv,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        for (const caseDaemon of p04Daemons.splice(0).reverse()) await caseDaemon.stop().catch(() => {});
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('P04.F1 Events detail to saved automation', async ({ page }) => {
        test.setTimeout(900_000);
        const { context, serverId, event, arrive } = await startP04DeploymentEventsCase(page, 'p04-f1');
        const sourceName = event.event.title;
        await gotoDomContentLoadedWithRetries(page, `${context.uiBaseUrl}/workflows`);
        await page.getByRole('tab', { name: 'Events', exact: true }).click();
        await expect(page).toHaveURL(/\/workflows\/events(?:\?|$)/);
        // Opening Events must not treat the reserved route segment as a definition id.
        await expect(page.getByText('Workflow not found', { exact: true })).toHaveCount(0);
        await openP04DeploymentFailure(page, sourceName, arrive);
        await invokeP04MountedCommand(context, 'f1-add-to-workflow', /^Add to a workflow$/);
        await page.getByTestId('automation-plugin-event-cancel').click();
        await expect(page.getByTestId('workflow-event-add-to-workflow')).toBeVisible();
        await page.getByTestId('workflow-event-add-to-cancel').click();

        await invokeP04MountedCommand(context, 'f1-make-workflow', /^Make a workflow from this$/);
        await expect(page.getByTestId('workflow-editor-name')).toHaveValue(sourceName);
        await expect(page.locator('[data-testid^="workflow-editor-sentence-trigger:new:"][data-testid$="-detail"]')).toBeVisible();

        await selectP04DeploymentFailure(page, sourceName, { discardDraft: true });
        await expect(page.getByRole('button', { name: 'Automate this…', exact: true })).toBeVisible();
        await invokeP04MountedCommand(context, 'f1-automate', /^Automate this…$/);
        await expect(page.getByTestId('workflow-builder')).toBeVisible();
        await invokeP04MountedCommand(context, 'f1-continue-in-editor', /^Open.*editor$/i);
        await configureP04DeploymentTrigger(page, context.machineId, 'workflow-editor');
        const workflowName = 'P04 F1 saved from occurrence';
        await page.getByTestId('workflow-editor-name').fill(workflowName);
        await addP04Action(page, 'workflow-editor', 'machines.command.run');
        const command = page.locator('[data-testid^="workflow-editor-action-"][data-testid$="-field-command"]');
        await command.getByRole('button', { name: 'Set Command', exact: true }).click();
        await command.getByRole('textbox').fill('echo P04-F1-effect');
        await page.getByTestId('workflow-editor-save').click();
        const definitions = await invokeP04Action(context, 'f1-saved-definition', 'workflow.definition.list', {});
        expect(definitions.ok).toBe(true);
        const saved = WorkflowDefinitionListResultV1Schema.parse(definitions.data).definitions
            .find(row => row.metadata?.title === workflowName);
        expect(saved).toMatchObject({ contentStatus: 'available', stepCount: 1 });
        if (!saved) throw new Error('Events authoring did not save its ordinary Workflow');
        const links = await invokeP04Action(context, 'f1-saved-trigger', 'workflow.trigger.list', { workflow: saved.definitionId });
        expect(links.ok).toBe(true);
        const savedSets = WorkflowTriggerListResultV1Schema.parse(links.data).sets;
        expect(savedSets).toHaveLength(1);
        expect(savedSets[0].triggers).toHaveLength(1);
        const savedId = savedSets[0].automationId;
        // A later occurrence, rather than Save itself, starts the newly authored automation.
        expect(await readP04Runs(context, 'f1-before-repeat', savedId)).toEqual([]);
        await arrive();
        expect(await waitForP04Run(page, context, serverId, 'f1-arriving-run', savedId)).toMatchObject([{
            state: 'succeeded', sourceArtifactId: saved.definitionId,
            origin: { kind: 'automation', automationId: savedId, cause: {
                kind: 'trigger', triggerKind: 'pluginEvent', triggerId: savedSets[0].triggers[0].id,
                evidence: { eventRef: event.event.identity },
            } },
        }]);
    });

    test('P04.F3 sentence verbs create ordinary Workflows', async ({ page }) => {
        // Four sequential browser Saves and daemon effects use the long UI journey budget.
        test.setTimeout(20 * 60_000);
        const { context, serverId, event, arrive } = await startP04DeploymentEventsCase(page, 'p04-f3');
        const sourceName = event.event.title;
        const sessionTarget = {
            executionTarget: { serverId, machineId: context.machineId },
            directory: { kind: 'path', path: context.cliHomeDir },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } as const;
        const spawn = await invokeP04Action(context, 'f3-recipient-session', SESSION_SPAWN_NEW_ACTION_ID_V1, {
            ...sessionTarget,
            terminal: { mode: 'plain' },
        });
        expect(spawn.ok, 'Recipient Session spawn Action succeeded').toBe(true);
        const recipient = SessionSpawnNewActionResultV1Schema.parse(spawn.data);
        expect(recipient.type).toBe('success');
        if (recipient.type !== 'success') throw new Error('Recipient Session did not start');
        const verbs = [
            { name: 'command', actionId: 'machines.command.run', insertField: 'stdin', fields: { command: 'echo sentence-effect', stdin: '' } },
            { name: 'message', actionId: 'session.message.send', insertField: 'message', fields: { sessionId: recipient.sessionId, message: 'Sentence message effect: ' } },
            { name: 'Session', actionId: SESSION_SPAWN_NEW_ACTION_ID_V1, insertField: 'title', fields: {
                ...sessionTarget, title: 'Sentence Session: ' } },
            { name: 'another Action', actionId: 'machines.processes.list', insertField: 'query', fields: {
                serverId, machineId: context.machineId, query: 'Deployment state: ' } },
        ] as const;
        for (const verb of verbs) {
            await gotoDomContentLoadedWithRetries(page, `${context.uiBaseUrl}/workflows/events`);
            await openP04DeploymentFailure(page, sourceName, arrive);
            await page.getByRole('button', { name: 'Automate this…', exact: true }).click();
            await expect(page.getByTestId('workflow-builder')).toBeVisible();
            await configureP04DeploymentTrigger(page, context.machineId, 'workflow-builder');
            const name = `Sentence ${verb.name} ${run.runId}`;
            await page.getByTestId('workflow-builder-name').fill(name);
            await addP04Action(page, 'workflow-builder', verb.actionId);
            for (const [field, value] of Object.entries(verb.fields)) {
                const fieldRow = page.locator(`[data-testid^="workflow-builder-action-"][data-testid$="-field-${field}"]`);
                if (!(await fieldRow.isVisible())) {
                    await page.locator('[data-testid^="workflow-builder-action-"][data-testid$="-more-settings"]').click();
                }
                const setField = page.locator(`[data-testid^="workflow-builder-action-"][data-testid$="-field-${field}-set"]`);
                if (await setField.isVisible()) await setField.click();
                if (field === 'executionTarget') {
                    for (const [key, operand] of Object.entries(sessionTarget.executionTarget)) {
                        await fieldRow.locator(`[data-testid$="-literal:executionTarget.${key}"]`).fill(operand);
                    }
                } else if (value !== '') {
                    await fieldRow.getByRole('textbox').fill(typeof value === 'string' ? value : JSON.stringify(value));
                }
            }
            const fieldSelector = `[data-testid^="workflow-builder-action-"][data-testid$="-field-${verb.insertField}"]`;
            const input = page.locator(fieldSelector);
            const picker = verb.name === 'command' ? 'input-0-value' : 'insert-list';
            const openPicker = verb.name === 'command' ? 'input-0-value-trigger' : 'insert';
            await input.locator(`[data-testid$="-field-${verb.insertField}-${openPicker}"]`).click();
            await page.locator(`[data-testid*="-field-${verb.insertField}-${picker}-option-"]`)
                .and(page.getByRole('button', { name: 'State', exact: true })).click();
            await page.getByTestId('workflow-builder-save').click();
            const listed = await invokeP04Action(context, `f3-list-${verb.name}`, 'workflow.definition.list', {});
            expect(listed.ok).toBe(true);
            const matches = WorkflowDefinitionListResultV1Schema.parse(listed.data).definitions.filter(row => row.metadata?.title === name);
            expect(matches).toHaveLength(1);
            const definitionId = matches[0]!.definitionId;
            const [opened, attached] = await Promise.all([
                invokeP04Action(context, `f3-get-${verb.name}`, 'workflow.definition.get', { definitionId }),
                invokeP04Action(context, `f3-triggers-${verb.name}`, 'workflow.trigger.list', { workflow: definitionId }),
            ]);
            const saved = WorkflowDefinitionGetResultV1Schema.parse(opened.data);
            const expectedInput = Object.fromEntries(Object.entries(verb.fields)
                .filter(([key]) => key !== verb.insertField)
                .map(([key, value]) => [key, { kind: 'literal', value }]));
            expect(saved.definition.blocks).toMatchObject([{ kind: 'action', actionId: verb.actionId, input: expectedInput }]);
            const action = saved.definition.blocks[0];
            expect(action?.kind).toBe('action');
            if (action?.kind !== 'action') throw new Error('The sentence did not save its Action');
            const insertedBinding = action.input[verb.insertField];
            const reference = { kind: 'trigger_event', event: event.event.identity, path: ['state'] };
            expect(insertedBinding).toMatchObject(verb.name === 'command' ? reference : {
                kind: 'text', document: { references: [expect.any(Object)] }, input: [reference],
            });
            const sets = WorkflowTriggerListResultV1Schema.parse(attached.data).sets;
            expect(sets.flatMap(set => set.triggers)).toHaveLength(1);
            const automationId = sets[0]!.automationId;
            const runLabel = `f3-runs-${verb.name}`;
            const [beforeArrival] = await Promise.all([
                readP04Runs(context, `${runLabel}-before-arrival`, automationId),
                gotoDomContentLoadedWithRetries(page, `${context.uiBaseUrl}/workflows/${definitionId}`),
            ]);
            expect(beforeArrival).toEqual([]);
            const reopened = await invokeP04Action(context, `f3-reopened-${verb.name}`, 'workflow.definition.get', { definitionId });
            expect(WorkflowDefinitionGetResultV1Schema.parse(reopened.data).definition).toEqual(saved.definition);
            await arrive();
            const runs = await waitForP04Run(page, context, serverId, runLabel, automationId);
            expect(runs.map(({ state, errorCode }) => ({ state, errorCode: errorCode ?? null })), verb.name)
                .toEqual([{ state: 'succeeded', errorCode: null }]);
        }
    });

    test('authors plural V3 Automations and completes one exact-turn lifecycle journey', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
        const serverBaseUrl = server.baseUrl;

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

        const testDir = resolve(join(suiteDir, 't1-automations-authoring'));
        await mkdir(testDir, { recursive: true });

        const exactTurnFixtureDir = resolve(join(suiteDir, 't2-exact-turn'));
        await mkdir(exactTurnFixtureDir, { recursive: true });
        const fakeClaudeLogPath = resolve(join(exactTurnFixtureDir, 'fake-claude.jsonl'));
        const exactTurnHoldReleaseFile = resolve(join(exactTurnFixtureDir, 'release-exact-turn-hold'));

        daemon = await authenticateAndStartDaemon({
            page,
            testDir,
            cliHomeDir,
            serverUrl: serverBaseUrl,
            uiBaseUrl,
            createAccount: false,
            extraEnv: {
                HOME: cliHomeDir,
                // The exact-turn lane holds one real parent turn open through the
                // scenario-owned fake Claude boundary (no agent is mocked inside
                // the app); writing the release file later settles it.
                HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
                HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'daemon-runtime-continuity',
                HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: exactTurnHoldReleaseFile,
            },
        });

        await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
        const authToken = await readAuthTokenFromBrowserStorage(page);
        const machineId = await readMachineIdFromCliAuthLoginStdout(resolve(join(testDir, 'cli.auth.login.stdout.log')));

        await enableAutomationsInSettings({ page, baseUrl: uiBaseUrl });

        const inlineAutomationName = `Inline automation ${run.runId}`;
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await page.getByTestId('automation-name').first().fill(inlineAutomationName);
        const firstTriggerId = await addScheduleTrigger(page);
        const secondTriggerId = await addScheduleTrigger(page);
        expect(secondTriggerId).not.toBe(firstTriggerId);
        await page.getByTestId(`automation-trigger-row-${firstTriggerId}`).click();
        await page.getByTestId('automation-trigger-interval-minutes').fill('7');
        await page.getByTestId('automation-trigger-editor-done').click();
        await page.getByTestId(`automation-trigger-row-${secondTriggerId}`).click();
        await expect(page.getByTestId('automation-trigger-interval-minutes')).toHaveValue('60');
        await page.getByTestId('automation-trigger-editor-done').click();
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('automation-name')).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(0, { timeout: 60_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await page.getByTestId('automation-name').first().fill(inlineAutomationName);
        await expect(page.getByTestId(`automation-trigger-row-${firstTriggerId}`)).toHaveCount(1);
        await expect(page.getByTestId(`automation-trigger-row-${secondTriggerId}`)).toHaveCount(1);
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);
        await submitAutomationViaComposer({
            page,
            testId: 'new-session-composer-send',
            expectedPathname: '/automations',
        });
        const inlineAutomationId = await expectPersistedAutomation({
            baseUrl: serverBaseUrl,
            token: authToken,
            name: inlineAutomationName,
            targetType: 'newSession',
            expectedTriggers: [
                { id: firstTriggerId, kind: 'schedule', everyMs: 7 * 60_000 },
                { id: secondTriggerId, kind: 'schedule', everyMs: 60 * 60_000 },
            ],
        });
        const inlineAutomationsBeforeRename = await listPersistedAutomations({
            baseUrl: serverBaseUrl,
            token: authToken,
        });
        const inlineBeforeRename = inlineAutomationsBeforeRename.find(
            (automation) => automation.id === inlineAutomationId,
        );
        if (!inlineBeforeRename) {
            throw new Error('Inline automation disappeared from the definition list after creation');
        }

        const session = await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `session for automation ${run.runId}`,
        });
        const { sessionId } = session;

        const existingSessionAutomationName = `Existing automation ${run.runId}`;
        const existingSessionAutomationPrompt = `existing-session automation prompt ${run.runId}`;
        const automationAuthoringUrl = new URL(session.sessionHref);
        automationAuthoringUrl.pathname = `${automationAuthoringUrl.pathname}/automations/new`;
        automationAuthoringUrl.searchParams.set('happier_hmr', '0');
        await gotoDomContentLoadedWithRetries(page, automationAuthoringUrl.toString(), 180_000);
        await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('automation-name')).toHaveCount(0, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-name')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('automation-name').fill(existingSessionAutomationName);
        await getVisibleSessionComposer(page).fill(existingSessionAutomationPrompt);
        await submitAutomationViaComposer({
            page,
            testId: 'session-composer-send',
            expectedPathname: `/session/${sessionId}/automations`,
        });
        const existingAutomationId = await expectPersistedAutomation({
            baseUrl: serverBaseUrl,
            token: authToken,
            name: existingSessionAutomationName,
            targetType: 'existingSession',
        });

        // 10.1.1/10.1.3: a zero-trigger Automation still accepts an
        // authenticated Run Now, and the admitted Run records the immutable
        // manual invocation cause.
        const runNowButton = page.getByRole('button', { name: `Run now: ${existingSessionAutomationName}` });
        await expect(runNowButton).toHaveCount(1, { timeout: 60_000 });
        const [runNowResponse] = await Promise.all([
            page.waitForResponse((candidate) => {
                try {
                    return candidate.request().method() === 'POST'
                        && new URL(candidate.url()).pathname === `/v3/automations/${existingAutomationId}/run-now`;
                } catch {
                    return false;
                }
            }, { timeout: 60_000 }),
            runNowButton.click(),
        ]);
        expect(runNowResponse.ok()).toBe(true);
        const runNowBody = await runNowResponse.json() as { run?: PersistedAutomationRunRow };
        expect(runNowBody.run?.cause.kind).toBe('manual');
        const manualRunId = runNowBody.run?.id ?? null;
        if (manualRunId === null) {
            throw new Error('Run Now did not return the admitted Run identity');
        }
        await expect.poll(async () => (
            (await listPersistedAutomationRuns({
                baseUrl: serverBaseUrl,
                token: authToken,
                automationId: existingAutomationId,
            })).filter((candidate) => candidate.cause.kind === 'manual').length
        ), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

        // 10.4.4/10.2: the exact-turn Session action captures the exact current
        // parent turn and converges with the Automations editor on the one
        // canonical trigger writer, targeting a Session distinct from the source.
        const sourceSession = await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `DAEMON_RUNTIME_CONTINUITY_HOLD_${run.runId}`,
        });
        await waitForFakeClaudeRuntimeContinuityEffect({
            logPath: fakeClaudeLogPath,
            promptMarker: `DAEMON_RUNTIME_CONTINUITY_HOLD_${run.runId}`,
            timeoutMs: 120_000,
        });

        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/session/${sourceSession.sessionId}?happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
        await page.getByLabel('Open session actions').click();
        const exactTurnMenuItem = page.getByTestId('dropdown-option-header_automateExactTurnCompletion');
        await expect(exactTurnMenuItem).toHaveCount(1, { timeout: 180_000 });

        // 7.2: a failed automations refresh yields a typed retry state instead of
        // presenting cached destinations as current.
        await page.route('**/v3/automations', (route) => route.abort());
        await exactTurnMenuItem.click();
        await page.waitForURL((url) => url.pathname.endsWith('/automations/when-turn-finishes'), { timeout: 60_000 });
        const exactTurnRouteUrl = new URL(page.url());
        const observedTurnId = exactTurnRouteUrl.searchParams.get('sourceTurnId');
        const observedServerId = exactTurnRouteUrl.searchParams.get('sourceServerId');
        if (!observedTurnId || !observedServerId) {
            throw new Error('Session action did not preserve the exact observed turn identity');
        }
        const refreshFailedCard = page.getByTestId('exact-turn-automation-refresh-failed');
        await expect(refreshFailedCard).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('exact-turn-automation-destination')).toHaveCount(0);
        await page.unroute('**/v3/automations');
        await refreshFailedCard.getByTestId('exact-turn-automation-refresh-failed-action').click();
        const exactTurnDestination = page.getByTestId('exact-turn-automation-destination');
        await expect(exactTurnDestination).toHaveCount(1, { timeout: 60_000 });
        // The destination stays one searchable virtualized single-select list.
        await expect(exactTurnDestination.getByRole('listbox')).toHaveCount(1);
        const createNewDestinationOption = page.getByTestId('exact-turn-automation-create-new');
        await expect(createNewDestinationOption).toHaveCount(1);
        await expect(createNewDestinationOption).toHaveAttribute('role', 'option');
        await expect(createNewDestinationOption).toHaveAttribute('aria-selected', 'false');
        const existingDestinationOption = page.getByTestId(`exact-turn-automation-existing-${existingAutomationId}`);
        await expect(existingDestinationOption).toHaveCount(1);
        await existingDestinationOption.click();
        await page.waitForURL((url) => url.pathname.endsWith('/automations/edit'), { timeout: 60_000 });
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 120_000 });
        // The zero-trigger target owns no other rows, so the appended exact-turn
        // prefill is the one independently identified trigger row.
        const prefillRows = page.locator('[data-testid^="automation-trigger-row-"]');
        await expect(prefillRows).toHaveCount(1, { timeout: 60_000 });
        const prefillTriggerId = triggerIdFromRowTestId(await prefillRows.first().getAttribute('data-testid'));
        await expect(page.getByTestId(`automation-trigger-enabled-${prefillTriggerId}`))
            .toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });

        await saveAutomationEditorViaSubmit({ page, automationId: existingAutomationId });

        // 3.5/10.4: the saved trigger names the exact source turn while the
        // Automation target stays the distinct existing Session, and the
        // machine assignment survives the authoring flow.
        let savedLifecycleTriggerId: string | null = null;
        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: serverBaseUrl,
                token: authToken,
            })).find((automation) => automation.id === existingAutomationId);
            const lifecycle = found?.triggers.find((candidate) => candidate.kind === 'sessionLifecycle') ?? null;
            if (!found || !lifecycle) return null;
            savedLifecycleTriggerId = lifecycle.id;
            return {
                triggerId: lifecycle.id,
                enabled: lifecycle.enabled,
                events: lifecycle.events,
                sourceSessionId: lifecycle.sourceSessionId,
                sourceTurnId: lifecycle.policy.kind === 'currentTurn'
                    ? lifecycle.policy.sourceTurnId
                    : null,
                policy: lifecycle.policy.kind,
                remainingOccurrences: lifecycle.remainingOccurrences,
                status: lifecycle.status?.state ?? null,
                existingSessionId: found.existingSessionId,
                hasEnabledAssignment: found.assignments.some((assignment) => assignment.enabled),
            };
        }, { timeout: 60_000 }).toEqual({
            triggerId: expect.any(String),
            enabled: true,
            events: ['parentTurnCompleted'],
            sourceSessionId: sourceSession.sessionId,
            sourceTurnId: observedTurnId,
            policy: 'currentTurn',
            remainingOccurrences: 1,
            status: 'waiting',
            existingSessionId: sessionId,
            hasEnabledAssignment: true,
        });
        const persistedLifecycleTriggerId = requirePollResult<string>(
            savedLifecycleTriggerId,
            'Exact-turn trigger was not persisted with a durable identity',
        );

        // 10.2.2: settling the held parent turn admits exactly one exact-turn Run
        // whose immutable cause names the exact trigger and source facts.
        await releaseFakeClaudeRuntimeContinuityTurn(exactTurnHoldReleaseFile);
        let lifecycleRun: PersistedAutomationRunRow | null = null;
        await expect.poll(async () => {
            const runs = await listPersistedAutomationRuns({
                baseUrl: serverBaseUrl,
                token: authToken,
                automationId: existingAutomationId,
            });
            lifecycleRun = runs.find((candidate) => (
                candidate.cause.kind === 'trigger'
                && candidate.cause.triggerKind === 'sessionLifecycle'
                && candidate.cause.evidence.event === 'parentTurnCompleted'
                && candidate.cause.evidence?.sourceSessionId === sourceSession.sessionId
                && candidate.cause.evidence?.sourceTurnId === observedTurnId
            )) ?? null;
            return lifecycleRun?.id ?? null;
        }, { timeout: 180_000 }).not.toBeNull();
        const persistedLifecycleRun = requirePollResult<PersistedAutomationRunRow>(
            lifecycleRun,
            'Exact-turn Run was not admitted after the parent turn settled',
        );
        expect(persistedLifecycleRun.triggerId).toBe(persistedLifecycleTriggerId);
        expect(persistedLifecycleRun.triggerRetired).toBe(false);

        // Admission alone is not the composed user outcome. The same loaded
        // daemon must claim the exact-turn Run and deliver its Run-owned input
        // into the selected target Session.
        await expect.poll(async () => {
            const runs = await listPersistedAutomationRuns({
                baseUrl: serverBaseUrl,
                token: authToken,
                automationId: existingAutomationId,
            });
            return runs.find((candidate) => candidate.id === persistedLifecycleRun.id)?.state ?? null;
        }, { timeout: 180_000 }).toBe('succeeded');
        const expectedLifecycleInputId = `automation:run:${persistedLifecycleRun.id}`;
        await expect.poll(async () => {
            const messages = await listSessionMessages({
                baseUrl: serverBaseUrl,
                token: authToken,
                sessionId,
            });
            return messages.messages.some((message) => message.localId === expectedLifecycleInputId);
        }, { timeout: 120_000 }).toBe(true);
        const targetMessages = await listSessionMessages({
            baseUrl: serverBaseUrl,
            token: authToken,
            sessionId,
        });
        const lifecycleInput = targetMessages.messages.find((message) => message.localId === expectedLifecycleInputId);
        expect(lifecycleInput?.content).toEqual(expect.objectContaining({
            t: 'plain',
            v: expect.objectContaining({
                role: 'user',
                content: expect.objectContaining({
                    type: 'text',
                    text: existingSessionAutomationPrompt,
                }),
            }),
        }));
        // The owning trigger's projected status follows its admitted Run.
        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: serverBaseUrl,
                token: authToken,
            })).find((automation) => automation.id === existingAutomationId);
            const lifecycle = found?.triggers.find((candidate) => candidate.kind === 'sessionLifecycle') ?? null;
            return lifecycle ? { state: lifecycle.status?.state ?? null, runId: lifecycle.status?.runId ?? null } : null;
        }, { timeout: 60_000 }).toEqual({
            state: expect.stringMatching(/^(triggered|running|finished)$/u),
            runId: persistedLifecycleRun.id,
        });

        // 10.1.6: removing the trigger through the loaded editor keeps every
        // historical Run renderable from its immutable cause.
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/edit?id=${existingAutomationId}&happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 120_000 });
        const persistedTriggerRows = page.locator('[data-testid^="automation-trigger-row-"]');
        await expect(persistedTriggerRows).toHaveCount(1, { timeout: 60_000 });
        await persistedTriggerRows.first().click();
        await page.getByTestId('automation-trigger-remove').click();
        await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 30_000 });
        await page.getByTestId('web-modal-confirm').click();
        await expect(persistedTriggerRows).toHaveCount(0, { timeout: 30_000 });
        await saveAutomationEditorViaSubmit({ page, automationId: existingAutomationId });

        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: serverBaseUrl,
                token: authToken,
            })).find((automation) => automation.id === existingAutomationId);
            if (!found) return null;
            // The ordinary definition no longer carries a retired-trigger
            // census; per-Run retired truth below stays the history evidence.
            return found.triggers.map((candidate) => candidate.kind);
        }, { timeout: 60_000 }).toEqual([]);
        await expect.poll(async () => (
            (await listPersistedAutomationRuns({
                baseUrl: serverBaseUrl,
                token: authToken,
                automationId: existingAutomationId,
            })).map((candidate) => ({
                id: candidate.id,
                causeKind: candidate.cause.kind,
                triggerId: candidate.triggerId,
                triggerRetired: candidate.triggerRetired,
            }))
        ), { timeout: 60_000 }).toContainEqual({
            id: persistedLifecycleRun.id,
            causeKind: 'trigger',
            triggerId: persistedLifecycleTriggerId,
            triggerRetired: true,
        });
        const runHistoryAfterRemoval = await listPersistedAutomationRuns({
            baseUrl: serverBaseUrl,
            token: authToken,
            automationId: existingAutomationId,
        }).then((runs) => runs.map((candidate) => ({
            id: candidate.id,
            causeKind: candidate.cause.kind,
            triggerId: candidate.triggerId,
            triggerRetired: candidate.triggerRetired,
        })));
        expect(runHistoryAfterRemoval).toContainEqual({
            id: persistedLifecycleRun.id,
            causeKind: 'trigger',
            triggerId: persistedLifecycleTriggerId,
            triggerRetired: true,
        });
        // The manual zero-trigger Run keeps its own cause facts untouched.
        expect(runHistoryAfterRemoval).toContainEqual({
            id: manualRunId,
            causeKind: 'manual',
            triggerId: null,
            triggerRetired: false,
        });

        // The retired row stays presented and the retired trigger's historical
        // Run detail remains renderable from its immutable cause snapshot.
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/${existingAutomationId}?happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId(`automation-retired-trigger-${persistedLifecycleTriggerId}`))
            .toHaveCount(1, { timeout: 120_000 });
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/${existingAutomationId}/runs/${persistedLifecycleRun.id}?happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('automation-run-trigger-retired')).toHaveCount(1, { timeout: 120_000 });

        // 10.1.7: a name-only save plus one independent enablement edit must not
        // rotate the untouched trigger's identity, revision, or runtime state.
        const renamedAutomationName = `Inline automation renamed ${run.runId}`;
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/edit?id=${inlineAutomationId}&happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 120_000 });
        const inlineTriggerRows = page.locator('[data-testid^="automation-trigger-row-"]');
        await expect(inlineTriggerRows).toHaveCount(2, { timeout: 60_000 });
        const firstTriggerSwitch = page.getByTestId(`automation-trigger-enabled-${firstTriggerId}`);
        const secondTriggerSwitch = page.getByTestId(`automation-trigger-enabled-${secondTriggerId}`);
        await expect(firstTriggerSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
        await expect(secondTriggerSwitch).toHaveAttribute('aria-checked', 'true');
        const firstTriggerSwitchName = await firstTriggerSwitch.getAttribute('aria-label');
        const secondTriggerSwitchName = await secondTriggerSwitch.getAttribute('aria-label');
        expect(firstTriggerSwitchName).toBeTruthy();
        expect(secondTriggerSwitchName).toBeTruthy();
        expect(firstTriggerSwitchName).not.toBe(secondTriggerSwitchName);
        // Trigger kind choices stay named, keyboard-focusable buttons.
        await page.getByTestId('automation-trigger-add').click();
        for (const kind of ['schedule', 'pluginEvent', 'sessionLifecycle'] as const) {
            const kindChoice = page.getByTestId(`automation-trigger-kind-${kind}`);
            await expect(kindChoice).toHaveCount(1);
            await expect(kindChoice).toHaveAttribute('role', 'button');
            expect(((await kindChoice.innerText()) || '').trim().length).toBeGreaterThan(0);
        }
        // Leave the kind chooser without appending a row.
        await page.getByTestId(`automation-trigger-row-${firstTriggerId}`).click();
        await page.getByTestId('automation-trigger-editor-done').click();
        await expect(inlineTriggerRows).toHaveCount(2);
        await page.getByTestId(`automation-trigger-enabled-${firstTriggerId}`).click();
        await expect(page.getByTestId(`automation-trigger-enabled-${firstTriggerId}`))
            .toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
        await expect(page.getByTestId(`automation-trigger-enabled-${secondTriggerId}`))
            .toHaveAttribute('aria-checked', 'true');
        await page.getByTestId('automation-name').first().fill(renamedAutomationName);
        await saveAutomationEditorViaSubmit({ page, automationId: inlineAutomationId });

        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: serverBaseUrl,
                token: authToken,
            })).find((automation) => automation.id === inlineAutomationId);
            if (!found) return null;
            return {
                name: found.name,
                triggersById: Object.fromEntries(found.triggers.map((candidate) => [candidate.id, {
                    revision: candidate.revision,
                    enabled: candidate.enabled,
                }])),
            };
        }, { timeout: 60_000 }).toEqual({
            name: renamedAutomationName,
            triggersById: {
                [firstTriggerId]: { revision: expect.any(Number), enabled: false },
                [secondTriggerId]: { revision: expect.any(Number), enabled: true },
            },
        });
        const inlineAfterRename = (await listPersistedAutomations({
            baseUrl: serverBaseUrl,
            token: authToken,
        })).find((automation) => automation.id === inlineAutomationId);
        if (!inlineAfterRename) {
            throw new Error('Inline automation disappeared from the definition list after the rename save');
        }
        expect(inlineAfterRename.triggers.find((candidate) => candidate.id === firstTriggerId)?.revision)
            .toBeGreaterThan(inlineBeforeRename.triggers.find((candidate) => candidate.id === firstTriggerId)?.revision ?? -1);
        expect(inlineAfterRename.triggers.find((candidate) => candidate.id === secondTriggerId)?.revision)
            .toBe(inlineBeforeRename.triggers.find((candidate) => candidate.id === secondTriggerId)?.revision);

        // 7.2: a stale observed turn with no current replacement shows typed
        // truth and never offers silent retargeting.
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/session/${sourceSession.sessionId}/automations/when-turn-finishes`
                + `?sourceSessionId=${sourceSession.sessionId}&sourceTurnId=${observedTurnId}`
                + `&sourceServerId=${observedServerId}&happier_hmr=0`,
            180_000,
        );
        const staleTurnCard = page.getByTestId('exact-turn-automation-stale');
        await expect(staleTurnCard).toHaveCount(1, { timeout: 120_000 });
        await expect(staleTurnCard).toHaveAttribute('role', 'alert');
        await expect(page.getByTestId('exact-turn-automation-stale-action')).toHaveCount(0);
        await expect(page.getByTestId('exact-turn-automation-destination')).toHaveCount(0);
    });
});

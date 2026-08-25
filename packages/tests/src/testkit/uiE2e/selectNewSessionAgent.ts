import { expect, type Locator, type Page } from '@playwright/test';

const AGENT_PICKER_APPLY_TEST_ID = 'agent-input-chip-picker.apply';
const AGENT_PICKER_CLOSE_TEST_ID = 'agent-input-chip-picker.close';
const AGENT_PICKER_POPOVER_TEST_ID = 'agent-input-chip-picker-popover';
const AGENT_CHIP_TEST_ID = 'agent-input-agent-chip';
const WIZARD_AGENT_DROPDOWN_TRIGGER_TEST_ID = 'new-session-agent-dropdown-trigger';

function buildAgentOptionTestIds(agentId: string): string[] {
  const dropdownSafeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return [
    `dropdown-option-${dropdownSafeAgentId}`,
    `new-session-agent:${agentId}`,
    `agent-input-chip-picker.option:${agentId}`,
    `agent-input-chip-picker.option:agent:${agentId}`,
    `agent-input-chip-picker.option:engine:${agentId}`,
  ];
}

async function findActionableLocator(locator: Locator, timeout = 250): Promise<Locator | null> {
  const count = await locator.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    try {
      await candidate.click({ trial: true, timeout });
      return candidate;
    } catch {
      // Retained overlay and navigation layers can contain enabled, visible duplicates
      // that do not receive pointer events. Continue to the active locator instance.
    }
  }
  return null;
}

async function clickFirstActionableByTestIds(params: Readonly<{
  page: Page;
  testIds: readonly string[];
  timeout?: number;
}>): Promise<boolean> {
  for (const testId of params.testIds) {
    const actionable = await findActionableLocator(params.page.getByTestId(testId), params.timeout);
    if (actionable) {
      await actionable.click({ timeout: 1_000 });
      return true;
    }
  }
  return false;
}

async function maybeApplyAndClosePicker(page: Page): Promise<void> {
  const applyButton = await findActionableLocator(page.getByTestId(AGENT_PICKER_APPLY_TEST_ID));
  if (applyButton) {
    await applyButton.click({ timeout: 1_000 });
  }

  const closeButton = await findActionableLocator(page.getByTestId(AGENT_PICKER_CLOSE_TEST_ID));
  if (closeButton) {
    await closeButton.click({ timeout: 1_000 });
  }
}

async function openAgentSelectionSurface(page: Page): Promise<void> {
  for (const pathInputTestId of ['path-selection-list:header:input', 'path-selector-input']) {
    const pathInput = page.getByTestId(pathInputTestId).first();
    if ((await pathInput.getAttribute('aria-expanded', { timeout: 250 }).catch(() => null)) === 'true') {
      // A retained path suggestion list sits above the all-fields wizard and intercepts
      // the backend trigger. Close that sibling surface before opening agent selection.
      await pathInput.press('Escape');
    }
  }

  const wizardDropdownTrigger = await findActionableLocator(
    page.getByTestId(WIZARD_AGENT_DROPDOWN_TRIGGER_TEST_ID),
    15_000,
  );
  if (wizardDropdownTrigger) {
    await wizardDropdownTrigger.click({ timeout: 1_000 });
    return;
  }

  const agentChip = await findActionableLocator(page.getByTestId(AGENT_CHIP_TEST_ID), 15_000);
  if (agentChip) {
    await agentChip.click({ timeout: 1_000 });
    return;
  }

  throw new Error('Expected an actionable new-session agent selection trigger');
}

async function isAgentSelectionSurfaceOpen(params: Readonly<{
  page: Page;
  agentOptionTestIds: readonly string[];
}>): Promise<boolean> {
  if (await findActionableLocator(params.page.getByTestId(AGENT_PICKER_POPOVER_TEST_ID))) return true;
  if (await findActionableLocator(params.page.getByTestId(AGENT_PICKER_CLOSE_TEST_ID))) return true;

  const expandedTrigger = params.page.locator(
    `[data-testid="${WIZARD_AGENT_DROPDOWN_TRIGGER_TEST_ID}"][aria-expanded="true"]`,
  );
  if (await findActionableLocator(expandedTrigger)) return true;

  for (const testId of params.agentOptionTestIds) {
    if (await findActionableLocator(params.page.getByTestId(testId))) return true;
  }
  return false;
}

export async function selectNewSessionAgent(params: Readonly<{
  page: Page;
  agentId: string;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const agentOptionTestIds = buildAgentOptionTestIds(params.agentId);

  await openAgentSelectionSurface(params.page);

  await expect.poll(async () => {
    if (await clickFirstActionableByTestIds({
      page: params.page,
      testIds: agentOptionTestIds,
      timeout: 2_000,
    })) {
      await maybeApplyAndClosePicker(params.page);
      return true;
    }

    const escapedAgentId = params.agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const semanticOption = await findActionableLocator(
      params.page.getByRole('option', { name: new RegExp(escapedAgentId, 'i') }),
      250,
    ) ?? await findActionableLocator(
      params.page.getByRole('button', { name: new RegExp(escapedAgentId, 'i') }),
      250,
    );
    if (semanticOption) {
      await semanticOption.click({ timeout: 1_000 });
      await maybeApplyAndClosePicker(params.page);
      return true;
    }

    if (!await isAgentSelectionSurfaceOpen({ page: params.page, agentOptionTestIds })) {
      await openAgentSelectionSurface(params.page);
    }
    return false;
  }, {
    timeout: timeoutMs,
    message: `Expected selectable new-session agent option for "${params.agentId}"`,
  }).toBe(true);
}

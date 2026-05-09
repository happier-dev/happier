import { expect, type Page } from '@playwright/test';

const AGENT_PICKER_APPLY_TEST_ID = 'agent-input-chip-picker.apply';
const AGENT_PICKER_CLOSE_TEST_ID = 'agent-input-chip-picker.close';
const AGENT_CHIP_TEST_ID = 'agent-input-agent-chip';
const WIZARD_AGENT_DROPDOWN_TRIGGER_TEST_ID = 'new-session-agent-dropdown-trigger';

const AGENT_LABEL_BY_ID: Readonly<Record<string, string>> = {
  codex: 'Codex',
};

function expectedAgentLabel(agentId: string): string {
  return AGENT_LABEL_BY_ID[agentId] ?? agentId;
}

function buildAgentOptionTestIds(agentId: string): string[] {
  const dropdownSafeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return [
    `dropdown-option-${dropdownSafeAgentId}`,
    `new-session-agent:${agentId}`,
    `agent-input-chip-picker.option:${agentId}`,
    `agent-input-chip-picker.option:engine:${agentId}`,
  ];
}

async function clickFirstEnabledOption(params: Readonly<{
  page: Page;
  agentOptionTestIds: readonly string[];
}>): Promise<boolean> {
  const openDialogs = params.page.locator('[role="dialog"][data-state="open"]');
  const topDialog = openDialogs.last();

  const clickByTestId = async (testId: string): Promise<boolean> => {
    const dialogOption = topDialog.getByTestId(testId).first();
    if ((await dialogOption.count()) > 0) {
      await expect(dialogOption).toBeEnabled({ timeout: 60_000 });
      await dialogOption.click();
      return true;
    }

    const inlineOption = params.page.locator(`[data-testid="${testId}"]:visible`).first();
    if ((await inlineOption.count()) > 0) {
      await expect(inlineOption).toBeEnabled({ timeout: 60_000 });
      await inlineOption.click();
      return true;
    }

    return false;
  };

  for (const optionTestId of params.agentOptionTestIds) {
    if (await clickByTestId(optionTestId)) return true;
  }

  return false;
}

async function maybeApplyAndClosePicker(page: Page): Promise<void> {
  const applyButton = page.getByTestId(AGENT_PICKER_APPLY_TEST_ID).first();
  if ((await applyButton.count()) > 0) {
    await expect(applyButton).toBeEnabled({ timeout: 60_000 });
    await applyButton.click();
  }

  const closeButton = page.getByTestId(AGENT_PICKER_CLOSE_TEST_ID).first();
  if ((await closeButton.count()) > 0) {
    await closeButton.click().catch(() => {});
    await expect(closeButton).toHaveCount(0, { timeout: 30_000 }).catch(() => {});
  }
}

async function openAgentSelectionSurface(page: Page): Promise<void> {
  const wizardDropdownTrigger = page.getByTestId(WIZARD_AGENT_DROPDOWN_TRIGGER_TEST_ID).first();
  if ((await wizardDropdownTrigger.count()) > 0) {
    await wizardDropdownTrigger.click();
    return;
  }

  const agentChip = page.getByTestId(AGENT_CHIP_TEST_ID).first();
  if ((await agentChip.count()) > 0) {
    await agentChip.click();
  }
}

async function isAgentSelected(params: Readonly<{
  page: Page;
  agentId: string;
}>): Promise<boolean> {
  const expectedLabel = expectedAgentLabel(params.agentId);
  const selectedSurfaces = [
    params.page.getByTestId(WIZARD_AGENT_DROPDOWN_TRIGGER_TEST_ID).first(),
    params.page.getByTestId(AGENT_CHIP_TEST_ID).first(),
  ];

  for (const surface of selectedSurfaces) {
    if ((await surface.count()) === 0) continue;
    const text = await surface.textContent().catch(() => null);
    if (text?.toLowerCase().includes(expectedLabel.toLowerCase())) return true;
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
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isAgentSelected({ page: params.page, agentId: params.agentId })) return;

    await openAgentSelectionSurface(params.page);

    if (await clickFirstEnabledOption({ page: params.page, agentOptionTestIds })) {
      await maybeApplyAndClosePicker(params.page);
      if (await isAgentSelected({ page: params.page, agentId: params.agentId })) return;
    }

    await params.page.waitForTimeout(250);
  }

  const visibleAgentOptionTestIds = await params.page.locator('[data-testid]').evaluateAll((nodes) => {
    return nodes
      .map((node) => node.getAttribute('data-testid'))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .filter((value) => value.startsWith('new-session-agent:') || value.startsWith('agent-input-chip-picker.option:'));
  }).catch(() => []);

  throw new Error(
    `Expected selectable new-session agent option for "${params.agentId}", but no known option testIDs appeared. Visible option testIDs: ${
      visibleAgentOptionTestIds.length > 0 ? visibleAgentOptionTestIds.join(', ') : '(none)'
    }`,
  );
}

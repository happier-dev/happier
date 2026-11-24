import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from 'react-native';

import { readPresentationNotices, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { Modal } from '@/modal/ModalManager';
import type { ModalShowConfig } from '@/modal/types';
import { t } from '@/text';

import { presentActionAutomationSkipNotice } from './actionAutomationSkipNotice';

describe('presentActionAutomationSkipNotice', () => {
  const originalOs = Platform.OS;
  const shown: ModalShowConfig[] = [];
  beforeEach(() => {
    // The hosted app dialog (web, and every scoped command) is the dialog boundary: nothing here may reach it.
    Platform.OS = 'web';
    shown.length = 0;
    Modal.setFunctions(
      (config) => {
        shown.push(config);
        return `modal-${shown.length}`;
      },
      () => {},
      () => {},
    );
  });
  afterEach(() => {
    Platform.OS = originalOs;
    retirePresentationNotice();
  });

  const notChecked = { code: 'action_automations_not_checked' as const, reason: 'automation_index_unavailable' };

  it('says a reason shared by several skipped checks once, as a notice (QA-B reload1120-r24-skip-390)', async () => {
    // Two different checks, each skipped because it needs a Machine.
    const skip = (automationId: string) => ({
      code: 'action_automation_skipped' as const,
      reason: 'machineRequired',
      automationId,
      triggerId: `before-${automationId}`,
      workflowId: 'workflow-1',
    });
    await presentActionAutomationSkipNotice({ automationNotices: [skip('check-1'), skip('check-2')] });
    expect(shown).toHaveLength(0);
    expect(readPresentationNotices().map(notice => notice.message)).toEqual([
      t('workflows.triggers.checks.skippedNeedsMachine', { workflow: t('workflows.triggers.checks.aCheck') }),
    ]);
  });

  it("says an Action proceeded without its checks as a passing notice, never a dialog (R11)", async () => {
    await presentActionAutomationSkipNotice({ automationNotices: [notChecked] });
    expect(shown).toHaveLength(0);
    expect(readPresentationNotices()).toEqual([
      expect.objectContaining({ message: t('workflows.triggers.checks.notChecked'), severity: 'info' }),
    ]);
    expect(readPresentationNotices()[0]?.sticky).toBeUndefined();
  });

  it('puts the reason in words, not its code', async () => {
    await presentActionAutomationSkipNotice({ automationNotices: [{ ...notChecked, reason: 'database_connection_unavailable' }] });
    expect(readPresentationNotices().map(notice => notice.message)).toEqual([t('workflows.triggers.checks.notCheckedHomeUnavailable')]);
  });

  it('shows one notice for several Actions in a row with the same cause', async () => {
    for (let index = 0; index < 3; index += 1) await presentActionAutomationSkipNotice({ automationNotices: [notChecked] });
    expect(readPresentationNotices()).toHaveLength(1);
    expect(shown).toHaveLength(0);
  });

  it('adds nothing for a refused Action: the refusal is its failure, presented by its own owner', async () => {
    await presentActionAutomationSkipNotice({ automationNotices: [] });
    await presentActionAutomationSkipNotice({});
    expect(readPresentationNotices()).toHaveLength(0);
    expect(shown).toHaveLength(0);
  });
});

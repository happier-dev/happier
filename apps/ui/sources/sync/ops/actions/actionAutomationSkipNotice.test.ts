import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from 'react-native';

import { Modal } from '@/modal/ModalManager';
import type { ModalShowConfig } from '@/modal/types';
import { t } from '@/text';

import { presentActionAutomationSkipNotice } from './actionAutomationSkipNotice';

describe('presentActionAutomationSkipNotice', () => {
  const originalOs = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOs;
  });

  it('says a reason shared by several skipped checks once (QA-B reload1120-r24-skip-390)', () => {
    // The hosted app dialog (web, and every scoped command) is the presentation boundary.
    Platform.OS = 'web';
    const shown: ModalShowConfig[] = [];
    Modal.setFunctions(
      (config) => {
        shown.push(config);
        return `modal-${shown.length}`;
      },
      () => {},
      () => {},
    );
    // Two different checks, each skipped because it needs a Machine.
    const skip = (automationId: string) => ({
      code: 'action_automation_skipped' as const,
      reason: 'machineRequired',
      automationId,
      triggerId: `before-${automationId}`,
      workflowId: 'workflow-1',
    });
    presentActionAutomationSkipNotice({
      automationNotices: [skip('check-1'), skip('check-2')],
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      type: 'alert',
      message: t('workflows.triggers.checks.skippedNeedsMachine', {
        workflow: t('workflows.triggers.checks.aCheck'),
      }),
    });
  });
});

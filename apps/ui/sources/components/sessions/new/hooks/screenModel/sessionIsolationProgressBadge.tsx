import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import {
  buildManagedProgressStatusBadge,
  type ManagedProgressModel,
} from '@/components/machines/managed/managedComposerBadges';
import { describeManagedCreationProgress } from '@/components/settings/machines/managed/managedCreationProgressPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import type { NewSessionScreenModel } from '../newSessionScreenModelTypes';

const STEP_LABEL = {
  create: () => t('machineDetailPage.isolation.progress.create'),
  install: () => t('machineDetailPage.isolation.progress.install'),
  setup: () => t('machineDetailPage.isolation.progress.setup'),
  ready: () => t('machineDetailPage.isolation.progress.ready'),
} as const;

/**
 * First send into a sandbox (lab machine-sandboxes-1115 scene 3): the accepted Session operation's observed steps,
 * Creating sandbox → Installing Happier → Running setup → Ready, in the composer's one progress badge. Only the
 * steps the progress owner observed are shown (`describeManagedCreationProgress`); the message waits meanwhile.
 */
export function buildSessionIsolationProgressBadge(
  isolation: NewSessionScreenModel['sessionIsolation'],
): AgentInputStatusBadge | null {
  const progress = isolation?.progress;
  if (!progress || progress.kind !== 'session_starting') return null;
  const machine = isolation.machineName ?? t('common.machine');
  const described = describeManagedCreationProgress(machine, progress);
  if (described.steps.length === 0) return null;
  const stages: ManagedProgressModel['stages'] = described.steps.map(
    (step) => ({
      id: step.id,
      label: STEP_LABEL[step.id](),
      state: step.state,
    }),
  );
  const current = stages.find(
    (stage) => stage.state === 'running' || stage.state === 'failed',
  );
  return buildManagedProgressStatusBadge({
    machineName: machine,
    mark: <Icon name="cube" size={15} />,
    launch: t('machineDetailPage.isolation.progress.title', { machine }),
    stages,
    failed: described.failed,
    failureTitle: t('machineDetailPage.isolation.progress.failed', { machine }),
    failureLabel: t('machineDetailPage.isolation.progress.failed', { machine }),
    tone: described.tone,
    label:
      current?.label ??
      t('machineDetailPage.isolation.progress.title', { machine }),
    message: t('machineDetailPage.isolation.progress.waiting'),
  });
}

import * as React from 'react';
import {
  normalizeExecutableParticipantSelectionV1,
  type ExecutableParticipantSelectionV1,
} from '@happier-dev/protocol/discussions/executableParticipants';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { t } from '@/text';

/** Read-only naming from the selected recipe and this Home's existing inventory. */
export function resolveExecutableModelParticipantDisplay(
  launch: Extract<ExecutableParticipantSelectionV1, { kind: 'model' }>['launch'],
  machines: readonly Machine[],
) {
  const agentId = resolveBundledAgentIdFromContributionIdentity(launch.agentTarget.identity);
  const agentLabel = resolveAgentCatalogTitle(agentId ?? launch.agentTarget.identity.localId);
  const modelId = launch.modelSelection?.ref.modelId ?? launch.configuration?.model.value;
  // Match ordinary Session authoring: a selected freeform id remains its label
  // when the Agent catalog supplies none; it is never reinterpreted as default.
  const modelLabel = resolveSessionModelLabel(agentId ?? launch.agentTarget.identity.localId, null, modelId ?? 'default')
    ?? (modelId && modelId !== 'default' ? modelId : t('agentInput.model.useCliSettings'));
  const machine = machines.find(entry => entry.id === launch.executionTarget.machineId);
  const machineLabel = getMachineDisplayName(machine ?? { id: launch.executionTarget.machineId, absence: 'unlisted' }, machines);
  return { agentId, agentLabel, modelLabel, machineLabel,
    displayLabel: [agentLabel, modelLabel, machineLabel].filter(Boolean).join(' · ') };
}

function readSelections(
  value: unknown,
): readonly ExecutableParticipantSelectionV1[] {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return values.flatMap((entry) => {
    const selection = normalizeExecutableParticipantSelectionV1(entry);
    return selection ? [selection] : [];
  });
}

/**
 * What a chosen participant value reads as in its field: a session by its title, a model by the
 * session it will start. Mount it only in a field that holds a participant value.
 */
export function useExecutableParticipantLabel(
  value: unknown,
  serverId: string | null,
  enabled = true,
): string | undefined {
  const selections = React.useMemo(() => readSelections(value), [value]);
  const addresses = React.useMemo(
    () =>
      enabled ? selections.flatMap((selection) =>
        selection.kind === 'session'
          ? [
              {
                serverId: selection.session.serverId,
                sessionId: selection.session.sessionId,
              },
            ]
          : [],
      ) : [],
    [enabled, selections],
  );
  const titles = useSessionDisplayTitles(addresses);
  const machines = useMachineListForServer(serverId ?? '', enabled && selections.some(selection => selection.kind === 'model'));
  const label = React.useMemo(() => {
    if (!enabled) return undefined;
    if (selections.length === 0) return undefined;
    let sessionIndex = 0;
    return selections
      .map((selection) => {
        if (selection.kind === 'session') {
          return (
            titles[sessionIndex++] ??
            t('session.collaboration.discussion.participants.session')
          );
        }
        if (selection.launch.title) return selection.launch.title;
        const machine = (machines ?? []).find(
          (entry) => entry.id === selection.launch.executionTarget.machineId,
        );
        return t('workflows.start.participantModel', {
          agent: resolveAgentCatalogTitle(selection.launch.agentTarget.identity.localId),
          machine: (machine ? getMachineDisplayName(machine) : null) ?? t('session.collaboration.unnamed'),
        });
      })
      .join(', ');
  }, [enabled, machines, selections, titles]);
  // A retained field keeps its last label while its detail subscriptions are withdrawn.
  const retainedLabel = React.useRef(label);
  React.useLayoutEffect(() => { if (enabled) retainedLabel.current = label; }, [enabled, label]);
  return enabled ? label : retainedLabel.current;
}

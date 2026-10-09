import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { canCreateNewSession } from '@/components/sessions/new/modules/canCreateNewSession';
import {
    resolveEffectiveAutomationDraft,
    shouldShowAutomationActionChips,
} from '@/components/sessions/new/modules/automationFeatureGate';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';

import type { NewSessionAuthoringContext } from './sessionAuthoringContext';

export function buildNewSessionAuthoringContext(params: Readonly<{
    automationDraft: NewSessionAutomationDraft;
    automationFeatureEnabled: boolean;
    selectedMachineId: string | null;
    managedMachineSelection?: ManagedMachineSelectionDraft | null;
    selectedMachine: Machine | null;
    hostBoundMachineId?: string | null;
    selectedMachineSpawnReadiness?: MachineSpawnReadiness | null;
    selectedPath: string;
    directoryKind?: 'path' | 'managed';
    buildDraft: (effectiveAutomationDraft: NewSessionAutomationDraft) => SessionAuthoringDraft;
}>): NewSessionAuthoringContext {
    const effectiveAutomationDraft = resolveEffectiveAutomationDraft({
        draft: params.automationDraft,
        automationsEnabled: params.automationFeatureEnabled,
    });

    return {
        kind: 'newSession',
        draft: params.buildDraft(effectiveAutomationDraft),
        effectiveAutomationDraft,
        showAutomationActionChips: shouldShowAutomationActionChips({
            automationsEnabled: params.automationFeatureEnabled,
        }),
        // Submit always launches: creating an Automation is the shared
        // wrapper's journey, and a hydrated pre-change Automation draft is
        // handed there.
        canSubmit: canCreateNewSession({
            managedMachineSelection: params.managedMachineSelection,
            selectedMachineId: params.selectedMachineId,
            selectedMachine: params.selectedMachine,
            hostBoundMachineId: params.hostBoundMachineId,
            selectedPath: params.selectedPath,
            directoryKind: params.directoryKind,
            spawnReadiness: params.selectedMachineSpawnReadiness,
            executionTarget: params.buildDraft(effectiveAutomationDraft).executionTarget,
        }),
    };
}
